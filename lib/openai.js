const OpenAI = require("openai");
const { DateTime } = require("luxon");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function parseMessage(message) {
  const localParsed = parseLocally(message);
  if (localParsed.type !== "unknown") return localParsed;
  if (process.env.OPENAI_ENABLED !== "true") return { type: "unknown" };

  const today = DateTime.now().setZone("Asia/Tokyo");
  const monthEnd = today.endOf("month").toISODate();

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You parse Japanese LINE messages for a personal budget bot.",
            "Return only JSON.",
            "Use Asia/Tokyo dates.",
            `Today is ${today.toISODate()}.`,
            `The current month ends on ${monthEnd}.`,
            "Supported outputs:",
            '{"type":"budget_setting","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","totalBudget":50000}',
            '{"type":"expense","itemName":"コンビニ","amount":600}',
            '{"type":"command","command":"remaining|today|list|reset|help"}',
            '{"type":"unknown"}',
            "Command mapping: 残り=remaining, 今日=today, 一覧=list, リセット=reset, ヘルプ=help.",
            "For expenses, extract an item name and yen amount. Remove particles like で if natural.",
            "If the year is omitted, infer the year from today. If the inferred date already passed and the expression is future-looking, use next year.",
            "If uncertain, return unknown.",
          ].join("\n"),
        },
        { role: "user", content: message },
      ],
    });
  } catch (error) {
    console.error("OpenAI parse failed", error);
    return localParsed.reason ? localParsed : { type: "unknown", reason: "openai_error" };
  }

  const content = completion.choices[0]?.message?.content;
  if (!content) return { type: "unknown" };

  try {
    const parsed = JSON.parse(content);
    return sanitizeParsed(parsed);
  } catch (_error) {
    return { type: "unknown" };
  }
}

function parseLocally(message) {
  const text = message.trim();
  const command = parseCommand(text);
  if (command) return { type: "command", command };

  const budget = parseBudget(text);
  if (budget) return budget;

  const expense = parseExpense(text);
  if (expense) return expense;

  return { type: "unknown", reason: "openai_error" };
}

function parseCommand(text) {
  const normalized = text.toLowerCase();
  const commands = new Map([
    ["残り", "remaining"],
    ["remaining", "remaining"],
    ["今日", "today"],
    ["today", "today"],
    ["一覧", "list"],
    ["list", "list"],
    ["リセット", "reset"],
    ["reset", "reset"],
    ["ヘルプ", "help"],
    ["help", "help"],
  ]);

  return commands.get(normalized);
}

function parseBudget(text) {
  const amount = extractAmount(text);
  if (!amount) return null;

  const today = DateTime.now().setZone("Asia/Tokyo");

  if (/今日から月末まで|今日から今月末まで|今月/.test(text)) {
    return {
      type: "budget_setting",
      startDate: today.toISODate(),
      endDate: today.endOf("month").toISODate(),
      totalBudget: amount,
    };
  }

  const rangeMatch = text.match(/(\d{1,2})\/(\d{1,2})\s*(?:〜|~|-|から)\s*(\d{1,2})\/(\d{1,2})/);
  if (rangeMatch) {
    const start = inferDate(Number(rangeMatch[1]), Number(rangeMatch[2]), today);
    let end = inferDate(Number(rangeMatch[3]), Number(rangeMatch[4]), today);
    if (end < start) end = end.plus({ years: 1 });

    return {
      type: "budget_setting",
      startDate: start.toISODate(),
      endDate: end.toISODate(),
      totalBudget: amount,
    };
  }

  const fromToMatch = text.match(/(\d{1,2})\/(\d{1,2})から(\d{1,2})\/(\d{1,2})まで/);
  if (fromToMatch) {
    const start = inferDate(Number(fromToMatch[1]), Number(fromToMatch[2]), today);
    let end = inferDate(Number(fromToMatch[3]), Number(fromToMatch[4]), today);
    if (end < start) end = end.plus({ years: 1 });

    return {
      type: "budget_setting",
      startDate: start.toISODate(),
      endDate: end.toISODate(),
      totalBudget: amount,
    };
  }

  return null;
}

function parseExpense(text) {
  const amountMatch = text.match(/([0-9０-９,，]+)\s*円?/);
  if (!amountMatch) return null;

  const amount = toNumber(amountMatch[1]);
  if (!amount) return null;

  let itemName = text.replace(amountMatch[0], "").trim();
  itemName = itemName.replace(/[でにをがは、,。.\s]+$/g, "").trim();
  itemName = itemName || "支出";

  return {
    type: "expense",
    itemName,
    amount,
  };
}

function extractAmount(text) {
  const yenMatches = [...text.matchAll(/([0-9０-９,，]+)\s*円/g)];
  if (yenMatches.length > 0) return toNumber(yenMatches[yenMatches.length - 1][1]);

  const numbers = [...text.matchAll(/[0-9０-９,，]+/g)]
    .map((match) => toNumber(match[0]))
    .filter(Boolean);
  if (numbers.length === 0) return null;

  return Math.max(...numbers);
}

function toNumber(value) {
  const normalized = value
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[,，]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function inferDate(month, day, today) {
  let date = DateTime.fromObject({ year: today.year, month, day }, { zone: "Asia/Tokyo" });
  if (!date.isValid) return date;
  if (date < today.startOf("day").minus({ months: 1 })) date = date.plus({ years: 1 });
  return date;
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
    return {
      type: "expense",
      itemName: String(parsed.itemName || "支出").trim(),
      amount: Number(parsed.amount),
    };
  }

  if (parsed.type === "command") {
    const allowed = new Set(["remaining", "today", "list", "reset", "help"]);
    return allowed.has(parsed.command)
      ? { type: "command", command: parsed.command }
      : { type: "unknown" };
  }

  return { type: "unknown" };
}

module.exports = {
  parseMessage,
};
