require("dotenv").config();

const express = require("express");
const { DateTime } = require("luxon");
const { validateLineSignature, replyText } = require("./lib/line");
const { parseMessage } = require("./lib/openai");
const {
  ensureSheets,
  getBudget,
  upsertBudget,
  appendExpense,
  listExpenses,
  deleteLastExpense,
  updateLastExpense,
  resetUserData,
} = require("./lib/sheets");
const {
  buildBudgetReply,
  buildExpenseReply,
  buildMultiExpenseReply,
  buildRemainingReply,
  buildTodayReply,
  buildListReply,
  buildWeekReply,
  buildRankingReply,
  buildUndoReply,
  buildEditReply,
  isBudgetExpired,
  normalizeBudgetPeriod,
} = require("./lib/budget");

const app = express();
const pendingResetUsers = new Map();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.get("x-line-signature");
  if (!validateLineSignature(req.body, signature)) {
    return res.status(401).json({ error: "Invalid LINE signature" });
  }

  let body;
  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch (_error) {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  res.status(200).end();

  for (const event of body.events || []) {
    handleEvent(event).catch((error) => console.error("Failed to handle event", error));
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message?.type !== "text") return;

  const userId = event.source?.userId;
  const replyToken = event.replyToken;
  const text = event.message.text.trim();
  if (!userId || !replyToken) return;

  try {
    console.log("Received text message", { userId, text, replyToken: "present" });

    const parsed = await parseMessage(text);
    if (parsed.type === "command" && parsed.command === "help") {
      await replyText(replyToken, helpMessage());
      return;
    }

    try {
      await ensureSheets();
    } catch (error) {
      console.error("Failed to prepare Google Sheets", error);
      await replyText(replyToken, "Google Sheetsへの接続に失敗しました。\n設定を確認して、もう一度試してください。");
      return;
    }

    if (pendingResetUsers.has(userId)) {
      await handleResetConfirmation(userId, replyToken, text);
      return;
    }

    const reply = await handleParsedMessage(userId, text, parsed);
    await replyText(replyToken, reply);
  } catch (error) {
    console.error(error);
    await replyText(replyToken, "すみません、処理中にエラーが起きました。\n時間をおいてもう一度試してください。");
  }
}

async function handleParsedMessage(userId, rawMessage, parsed) {
  if (!parsed || parsed.type === "unknown") {
    return "内容を読み取れませんでした。\n例：コンビニ 600円\n例：昨日 カフェ 500\n例：今月30000円\n「ヘルプ」で使い方を確認できます。";
  }

  if (parsed.type === "command") return handleCommand(userId, parsed.command);

  if (parsed.type === "budget_setting") return handleBudgetSetting(userId, parsed);

  if (parsed.type === "expense") {
    return handleExpense(userId, rawMessage, {
      date: parsed.date || todayIso(),
      itemName: parsed.itemName || "支出",
      amount: parsed.amount,
      category: parsed.category || "",
    });
  }

  if (parsed.type === "multi_expense") {
    return handleMultiExpense(userId, rawMessage, parsed.expenses || []);
  }

  if (parsed.type === "edit_last_expense") {
    return handleEditLastExpense(userId, parsed.amount);
  }

  return "内容を読み取れませんでした。\n「ヘルプ」で使い方を確認できます。";
}

async function handleBudgetSetting(userId, parsed) {
  if (!parsed.startDate || !parsed.endDate || !Number.isFinite(parsed.totalBudget)) {
    return "予算の期間か金額を読み取れませんでした。\n例：今月30000円";
  }

  const budget = normalizeBudgetPeriod({
    userId,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
    totalBudget: parsed.totalBudget,
  });

  if (!budget) return "予算期間を正しく読み取れませんでした。\n例：今日から月末まで30000円";

  try {
    await upsertBudget(budget);
  } catch (error) {
    console.error("Failed to save budget", error);
    return "Google Sheetsへの保存に失敗しました。\n少し待ってからもう一度試してください。";
  }

  return buildBudgetReply(budget);
}

async function handleExpense(userId, rawMessage, input) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return "金額を読み取れませんでした。\n例：コンビニ 600円";
  }

  const budget = await requireActiveBudget(userId);
  if (typeof budget === "string") return budget;

  const expense = {
    userId,
    date: input.date,
    itemName: input.itemName,
    amount: input.amount,
    rawMessage,
    category: input.category,
  };

  try {
    await appendExpense(expense);
    const expenses = await listExpenses(userId, budget.startDate, budget.endDate);
    return buildExpenseReply(expense, budget, expenses);
  } catch (error) {
    console.error("Failed to save expense", error);
    return "Google Sheetsへの保存に失敗しました。\n支出は記録できていない可能性があります。";
  }
}

async function handleMultiExpense(userId, rawMessage, inputs) {
  if (inputs.length === 0) return "支出を読み取れませんでした。\n例：固定費 家賃70000 通信費3000";

  const budget = await requireActiveBudget(userId);
  if (typeof budget === "string") return budget;

  const saved = inputs.map((input) => ({
    userId,
    date: input.date || todayIso(),
    itemName: input.itemName,
    amount: input.amount,
    rawMessage,
    category: input.category || "",
  }));

  try {
    for (const expense of saved) await appendExpense(expense);
    const expenses = await listExpenses(userId, budget.startDate, budget.endDate);
    return buildMultiExpenseReply(saved, budget, expenses);
  } catch (error) {
    console.error("Failed to save multiple expenses", error);
    return "Google Sheetsへの保存に失敗しました。\n支出は記録できていない可能性があります。";
  }
}

async function handleCommand(userId, command) {
  if (command === "help") return helpMessage();

  if (command === "reset") {
    pendingResetUsers.set(userId, Date.now());
    return "本当にリセットしますか？\n「はい」または「いいえ」で返信してください。";
  }

  const budget = await getBudget(userId);
  if (!budget) return "まだ予算が設定されていません。\n例：今月30000円";

  const expenses = await listExpenses(userId, budget.startDate, budget.endDate);
  if (command === "remaining") return buildRemainingReply(budget, expenses);
  if (command === "today") return buildTodayReply(expenses);
  if (command === "list") return buildListReply(expenses);
  if (command === "week") return buildWeekReply(budget, expenses);
  if (command === "ranking") return buildRankingReply(expenses);
  if (command === "undo") return handleUndo(userId, budget);

  return helpMessage();
}

async function handleUndo(userId, budget) {
  const deleted = await deleteLastExpense(userId, budget.startDate, budget.endDate);
  if (!deleted) return "取り消せる支出がありません。";

  const expenses = await listExpenses(userId, budget.startDate, budget.endDate);
  return buildUndoReply(deleted, budget, expenses);
}

async function handleEditLastExpense(userId, amount) {
  const budget = await requireActiveBudget(userId);
  if (typeof budget === "string") return budget;

  const result = await updateLastExpense(userId, budget.startDate, budget.endDate, { amount });
  if (!result) return "修正できる支出がありません。";

  const expenses = await listExpenses(userId, budget.startDate, budget.endDate);
  return buildEditReply(result.before, result.after, budget, expenses);
}

async function requireActiveBudget(userId) {
  const budget = await getBudget(userId);
  if (!budget) return "まだ予算が設定されていません。\n例：今月30000円";
  if (isBudgetExpired(budget)) {
    return "設定中の予算期間は終了しています。\n新しい予算を設定してください。\n例：今月30000円";
  }
  return budget;
}

async function handleResetConfirmation(userId, replyToken, text) {
  pendingResetUsers.delete(userId);
  if (["はい", "yes", "YES", "リセット"].includes(text.trim())) {
    await resetUserData(userId);
    await replyText(replyToken, "リセットしました。\n新しい予算を設定してください。");
    return;
  }

  await replyText(replyToken, "リセットをキャンセルしました。");
}

function todayIso() {
  return DateTime.now().setZone("Asia/Tokyo").toISODate();
}

function helpMessage() {
  return [
    "使い方",
    "予算：今月30000円 / 今週10000円",
    "支出：コンビニ 600円 / 昨日 カフェ 500 / 7/28 電車 220",
    "まとめ：固定費 家賃70000 通信費3000",
    "",
    "コマンド：",
    "残り / 今日 / 一覧 / 今週 / 多い順 / 取消 / リセット / ヘルプ",
    "修正：さっきの600円じゃなくて650円",
  ].join("\n");
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Budget bot listening on port ${port}`);
});
