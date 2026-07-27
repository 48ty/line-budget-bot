const OpenAI = require("openai");
const { DateTime } = require("luxon");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function parseMessage(message) {
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
    return { type: "unknown", reason: "openai_error" };
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
