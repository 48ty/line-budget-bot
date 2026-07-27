require("dotenv").config();

const express = require("express");
const { validateLineSignature, replyText } = require("./lib/line");
const { parseMessage } = require("./lib/openai");
const {
  ensureSheets,
  getBudget,
  upsertBudget,
  appendExpense,
  listExpenses,
  resetUserData,
} = require("./lib/sheets");
const {
  buildBudgetReply,
  buildExpenseReply,
  buildRemainingReply,
  buildTodayReply,
  buildListReply,
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
    handleEvent(event).catch((error) => {
      console.error("Failed to handle event", error);
    });
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message?.type !== "text") return;

  const userId = event.source?.userId;
  const replyToken = event.replyToken;
  const text = event.message.text.trim();

  if (!userId || !replyToken) return;

  try {
    try {
      await ensureSheets();
    } catch (error) {
      console.error("Failed to prepare Google Sheets", error);
      await replyText(
        replyToken,
        "Google Sheetsへの接続に失敗しました。\n設定を確認してから、もう一度試してください。"
      );
      return;
    }

    if (pendingResetUsers.has(userId)) {
      await handleResetConfirmation(userId, replyToken, text);
      return;
    }

    const parsed = await parseMessage(text);
    const reply = await handleParsedMessage(userId, text, parsed);
    await replyText(replyToken, reply);
  } catch (error) {
    console.error(error);
    await replyText(
      replyToken,
      "すみません、処理中にエラーが起きました。\n時間をおいてもう一度試してください。"
    );
  }
}

async function handleParsedMessage(userId, rawMessage, parsed) {
  if (parsed?.reason === "openai_error") {
    return "OpenAI APIで解析できませんでした。\n時間をおいてもう一度試してください。";
  }

  if (!parsed || parsed.type === "unknown") {
    return "内容を読み取れませんでした。\n例：コンビニ 600円\n例：今日から月末まで30000円\n「ヘルプ」で使い方を確認できます。";
  }

  if (parsed.type === "command") {
    return handleCommand(userId, parsed.command);
  }

  if (parsed.type === "budget_setting") {
    if (!parsed.startDate || !parsed.endDate || !Number.isFinite(parsed.totalBudget)) {
      return "予算の期間か金額を読み取れませんでした。\n例：7/1〜7/31 予算50000円で開始";
    }

    const budget = normalizeBudgetPeriod({
      userId,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      totalBudget: parsed.totalBudget,
    });

    if (!budget) {
      return "予算期間を正しく読み取れませんでした。\n例：今日から月末まで30000円";
    }

    try {
      await upsertBudget(budget);
    } catch (error) {
      console.error("Failed to save budget", error);
      return "Google Sheetsへの保存に失敗しました。\n少し待ってからもう一度試してください。";
    }

    return buildBudgetReply(budget);
  }

  if (parsed.type === "expense") {
    if (!Number.isFinite(parsed.amount) || parsed.amount <= 0) {
      return "金額を読み取れませんでした。\n例：コンビニ 600円";
    }

    const budget = await getBudget(userId);
    if (!budget) {
      return "まだ予算が設定されていません。\n例：今日から月末まで30000円";
    }

    if (isBudgetExpired(budget)) {
      return "設定中の予算期間は終了しています。\n新しい予算を設定してください。\n例：今日から月末まで30000円";
    }

    const expense = {
      userId,
      date: todayIso(),
      itemName: parsed.itemName || "支出",
      amount: parsed.amount,
      rawMessage,
    };

    let expenses;
    try {
      await appendExpense(expense);
      expenses = await listExpenses(userId, budget.startDate, budget.endDate);
    } catch (error) {
      console.error("Failed to save expense", error);
      return "Google Sheetsへの保存に失敗しました。\n支出は記録できていない可能性があります。";
    }

    return buildExpenseReply(expense, budget, expenses);
  }

  return "内容を読み取れませんでした。\n「ヘルプ」で使い方を確認できます。";
}

async function handleCommand(userId, command) {
  if (command === "help") return helpMessage();

  if (command === "reset") {
    pendingResetUsers.set(userId, Date.now());
    return "本当にリセットしますか？\n「はい」または「いいえ」で返信してください。";
  }

  const budget = await getBudget(userId);
  if (!budget) {
    return "まだ予算が設定されていません。\n例：今日から月末まで30000円";
  }

  const expenses = await listExpenses(userId, budget.startDate, budget.endDate);

  if (command === "remaining") return buildRemainingReply(budget, expenses);
  if (command === "today") return buildTodayReply(expenses);
  if (command === "list") return buildListReply(expenses);

  return helpMessage();
}

async function handleResetConfirmation(userId, replyToken, text) {
  pendingResetUsers.delete(userId);

  if (["はい", "yes", "YES", "リセット"].includes(text)) {
    await resetUserData(userId);
    await replyText(replyToken, "リセットしました。\n新しい予算を設定してください。");
    return;
  }

  await replyText(replyToken, "リセットをキャンセルしました。");
}

function todayIso() {
  return require("luxon").DateTime.now().setZone("Asia/Tokyo").toISODate();
}

function helpMessage() {
  return [
    "使い方",
    "予算設定：今日から月末まで30000円",
    "支出登録：コンビニ 600円",
    "",
    "コマンド：",
    "残り / 今日 / 一覧 / リセット / ヘルプ",
  ].join("\n");
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Budget bot listening on port ${port}`);
});
