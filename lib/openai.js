const OpenAI = require("openai");
const { DateTime } = require("luxon");

const ZONE = "Asia/Tokyo";
let client;

async function parseMessage(message) {
  const localParsed = parseLocally(message);
  if (localParsed.type !== "unknown") return localParsed;
  if (process.env.OPENAI_ENABLED !== "true") return { type: "unknown" };

  const today = DateTime.now().setZone(ZONE);
  const monthEnd = today.endOf("month").toISODate();

  try {
    client ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "Parse Japanese LINE messages for a personal budget bot. Return only JSON.",
            `Today is ${today.toISODate()} in Asia/Tokyo.`,
            `The current month ends on ${monthEnd}.`,
            "Types: budget_setting, expense, multi_expense, command, edit_last_expense, unknown.",
          ].join("\n"),
        },
        { role: "user", content: message },
      ],
    });

    return sanitizeParsed(JSON.parse(completion.choices[0]?.message?.content || "{}"));
  } catch (error) {
    console.error("OpenAI parse failed", error);
    return { type: "unknown" };
  }
}

function parseLocally(message) {
  const text = normalizeText(message);
  const command = parseCommand(text);
  if (command) return { type: "command", command };

  const edit = parseEditLastExpense(text);
  if (edit) return edit;

  const budget = parseBudget(text);
  if (budget) return budget;

  const multiExpense = parseMultiExpense(text);
  if (multiExpense) return multiExpense;

  const expense = parseExpense(text);
  if (expense) return expense;

  return { type: "unknown" };
}

function parseCommand(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, "");
  const commands = new Map([
    ["残り", "remaining"],
    ["のこり", "remaining"],
    ["remaining", "remaining"],
    ["今日", "today"],
    ["きょう", "today"],
    ["today", "today"],
    ["一覧", "list"],
    ["履歴", "list"],
    ["list", "list"],
    ["リセット", "reset"],
    ["reset", "reset"],
    ["ヘルプ", "help"],
    ["help", "help"],
    ["取消", "undo"],
    ["取り消し", "undo"],
    ["キャンセル", "undo"],
    ["undo", "undo"],
    ["今週", "week"],
    ["今週残り", "week"],
    ["週残り", "week"],
    ["多い順", "ranking"],
    ["ランキング", "ranking"],
    ["top", "ranking"],
  ]);

  return commands.get(normalized) || null;
}

function parseEditLastExpense(text) {
  if (!/(さっき|直前|最後).*(じゃなくて|ではなく|を|に|へ|変更|修正)/.test(text)) return null;
  const amount = extractAmount(text);
  if (!amount) return null;
  return { type: "edit_last_expense", amount };
}

function parseBudget(text) {
  const amount = extractAmount(text);
  if (!amount) return null;
  if (!/(予算|開始|月末|今月|今週|週予算|月予算|まで)/.test(text)) return null;

  const today = DateTime.now().setZone(ZONE).startOf("day");

  if (/(今日から)?(月末|今月末)まで|今月|月予算/.test(text)) {
    return {
      type: "budget_setting",
      startDate: today.toISODate(),
      endDate: today.endOf("month").toISODate(),
      totalBudget: amount,
    };
  }

  if (/今週|週予算/.test(text)) {
    return {
      type: "budget_setting",
      startDate: today.toISODate(),
      endDate: today.endOf("week").toISODate(),
      totalBudget: amount,
    };
  }

  const tomorrow = today.plus({ days: 1 });
  if (/今日から明日まで|明日まで/.test(text)) {
    return {
      type: "budget_setting",
      startDate: today.toISODate(),
      endDate: tomorrow.toISODate(),
      totalBudget: amount,
    };
  }

  const range = text.match(/(\d{1,2})\/(\d{1,2})\s*(?:〜|~|-|から)\s*(\d{1,2})\/(\d{1,2})/);
  if (range) return buildRangeBudget(range, amount, today);

  const fromTo = text.match(/(\d{1,2})\/(\d{1,2})から(\d{1,2})\/(\d{1,2})まで/);
  if (fromTo) return buildRangeBudget(fromTo, amount, today);

  return null;
}

function buildRangeBudget(match, amount, today) {
  const start = inferDate(Number(match[1]), Number(match[2]), today);
  let end = inferDate(Number(match[3]), Number(match[4]), today);
  if (!start.isValid || !end.isValid) return null;
  if (end < start) end = end.plus({ years: 1 });

  return {
    type: "budget_setting",
    startDate: start.toISODate(),
    endDate: end.toISODate(),
    totalBudget: amount,
  };
}

function parseMultiExpense(text) {
  if (!/固定費|まとめて|一括/.test(text)) return null;

  const date = extractExpenseDate(text);
  const expenses = [];
  const pattern = /([^\d０-９\s　,、。:：]+)\s*([0-9０-９,，]+)\s*円?/g;
  let match;
  while ((match = pattern.exec(removeDateWords(text))) !== null) {
    const itemName = cleanItemName(match[1]);
    const amount = toNumber(match[2]);
    if (itemName && amount && !/(固定費|まとめて|一括)/.test(itemName)) {
      expenses.push({ itemName, amount, date, category: categorize(itemName) });
    }
  }

  return expenses.length >= 2 ? { type: "multi_expense", expenses } : null;
}

function parseExpense(text) {
  const date = extractExpenseDate(text);
  const withoutDate = removeDateWords(text);
  const amountMatches = [...withoutDate.matchAll(/([0-9０-９,，]+)\s*円?/g)];
  const amountMatch = amountMatches[amountMatches.length - 1];
  if (!amountMatch) return null;

  const amount = toNumber(amountMatch[1]);
  if (!amount) return null;

  let itemName = withoutDate.replace(amountMatch[0], "").trim();
  itemName = cleanItemName(itemName) || "支出";

  return { type: "expense", itemName, amount, date, category: categorize(itemName) };
}

function extractExpenseDate(text) {
  const today = DateTime.now().setZone(ZONE).startOf("day");
  if (/昨日|きのう/.test(text)) return today.minus({ days: 1 }).toISODate();
  if (/一昨日|おととい/.test(text)) return today.minus({ days: 2 }).toISODate();
  if (/今日|きょう/.test(text)) return today.toISODate();

  const match = text.match(/(\d{1,2})\/(\d{1,2})/);
  if (!match) return null;
  return inferDate(Number(match[1]), Number(match[2]), today).toISODate();
}

function removeDateWords(text) {
  return text
    .replace(/一昨日|おととい|昨日|きのう|今日|きょう/g, "")
    .replace(/\d{1,2}\/\d{1,2}/g, "")
    .trim();
}

function cleanItemName(value) {
  return value
    .replace(/^(固定費|まとめて|一括)/, "")
    .replace(/[でにをがは、,。.\s　]+$/g, "")
    .replace(/^[でにをがは、,。.\s　]+/g, "")
    .trim();
}

function categorize(itemName) {
  const rules = [
    ["交通", /電車|バス|タクシー|交通|suica|pasmo|ガソリン|駐車/iu],
    ["固定費", /家賃|通信|スマホ|携帯|光熱|電気|ガス|水道|サブスク|保険|ローン/iu],
    ["日用品", /薬局|ドラッグ|日用品|洗剤|ティッシュ|トイレット/iu],
    ["娯楽", /映画|ゲーム|本|漫画|カラオケ|飲み|居酒屋/iu],
    ["食費", /コンビニ|スーパー|昼|昼飯|ランチ|夜|朝|カフェ|コーヒー|食|弁当|外食/iu],
  ];
  return rules.find(([, pattern]) => pattern.test(itemName))?.[0] || "その他";
}

function extractAmount(text) {
  const yenMatches = [...text.matchAll(/([0-9０-９,，]+)\s*円/g)];
  if (yenMatches.length > 0) return toNumber(yenMatches[yenMatches.length - 1][1]);

  const numbers = [...text.matchAll(/[0-9０-９,，]+/g)]
    .map((match) => toNumber(match[0]))
    .filter(Boolean);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function toNumber(value) {
  const normalized = value
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[,，]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function inferDate(month, day, today) {
  let date = DateTime.fromObject({ year: today.year, month, day }, { zone: ZONE });
  if (date.isValid && date < today.minus({ months: 1 })) date = date.plus({ years: 1 });
  return date;
}

function normalizeText(text) {
  return text.replace(/[￥¥]/g, "円").trim();
}

function sanitizeParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return { type: "unknown" };
  if (parsed.type === "budget_setting") {
    return {
      type: "budget_setting",
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      totalBudget: Number(parsed.totalBudget),
    };
  }
  if (parsed.type === "expense") {
    const itemName = String(parsed.itemName || "支出").trim();
    return {
      type: "expense",
      itemName,
      amount: Number(parsed.amount),
      date: parsed.date || null,
      category: parsed.category || categorize(itemName),
    };
  }
  if (parsed.type === "command") {
    const allowed = new Set(["remaining", "today", "list", "reset", "help", "undo", "week", "ranking"]);
    return allowed.has(parsed.command) ? { type: "command", command: parsed.command } : { type: "unknown" };
  }
  return { type: "unknown" };
}

module.exports = {
  parseMessage,
};
