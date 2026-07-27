const { DateTime } = require("luxon");

const ZONE = "Asia/Tokyo";

function normalizeBudgetPeriod(budget) {
  const start = DateTime.fromISO(budget.startDate, { zone: ZONE });
  const end = DateTime.fromISO(budget.endDate, { zone: ZONE });
  const totalBudget = Math.floor(Number(budget.totalBudget));

  if (!start.isValid || !end.isValid || end < start || !Number.isFinite(totalBudget) || totalBudget <= 0) {
    return null;
  }

  return {
    userId: budget.userId,
    startDate: start.toISODate(),
    endDate: end.toISODate(),
    totalBudget,
  };
}

function buildBudgetReply(budget) {
  const days = inclusiveDays(budget.startDate, budget.endDate);
  const daily = Math.floor(budget.totalBudget / days);

  return [
    "予算を設定しました。",
    `期間：${formatShortDate(budget.startDate)}〜${formatShortDate(budget.endDate)}`,
    `総予算：${formatYen(budget.totalBudget)}`,
    `1日あたり：約${formatNumber(daily)}円`,
  ].join("\n");
}

function buildExpenseReply(expense, budget, expenses) {
  const stats = calculateStats(budget, expenses);

  return [
    "記録しました。",
    `${expense.itemName}：${formatYen(expense.amount)}`,
    "",
    `今日の支出：${formatYen(stats.todayTotal)}`,
    `合計支出：${formatYen(stats.totalSpent)}`,
    `残り予算：${formatYen(stats.remainingBudget)}`,
    `残り日数：${stats.remainingDays}日`,
    `1日あたり使える金額：約${formatNumber(stats.dailyRemaining)}円`,
  ].join("\n");
}

function buildRemainingReply(budget, expenses) {
  const stats = calculateStats(budget, expenses);

  return [
    "現在の状況です。",
    `期間：${formatShortDate(budget.startDate)}〜${formatShortDate(budget.endDate)}`,
    `総予算：${formatYen(budget.totalBudget)}`,
    `合計支出：${formatYen(stats.totalSpent)}`,
    `残り予算：${formatYen(stats.remainingBudget)}`,
    `残り日数：${stats.remainingDays}日`,
    `1日あたり使える金額：約${formatNumber(stats.dailyRemaining)}円`,
  ].join("\n");
}

function buildTodayReply(expenses) {
  const today = todayIso();
  const todayExpenses = expenses.filter((expense) => expense.date === today);
  const total = sumAmounts(todayExpenses);

  if (todayExpenses.length === 0) {
    return "今日の支出はまだありません。";
  }

  return [
    "今日の支出",
    ...todayExpenses.map((expense) => `${expense.itemName}：${formatYen(expense.amount)}`),
    "",
    `合計：${formatYen(total)}`,
  ].join("\n");
}

function buildListReply(expenses) {
  if (expenses.length === 0) {
    return "この期間の支出はまだありません。";
  }

  const latest = [...expenses].slice(-20).reverse();
  const omitted = Math.max(expenses.length - latest.length, 0);

  return [
    "支出一覧（直近20件）",
    ...latest.map((expense) => {
      return `${formatShortDate(expense.date)} ${expense.itemName}：${formatYen(expense.amount)}`;
    }),
    omitted > 0 ? `\nほか${omitted}件あります。` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function calculateStats(budget, expenses) {
  const totalSpent = sumAmounts(expenses);
  const todayTotal = sumAmounts(expenses.filter((expense) => expense.date === todayIso()));
  const remainingBudget = budget.totalBudget - totalSpent;
  const remainingDays = daysFromTodayThrough(budget.endDate);
  const dailyRemaining = remainingDays > 0 ? Math.floor(remainingBudget / remainingDays) : 0;

  return {
    totalSpent,
    todayTotal,
    remainingBudget,
    remainingDays,
    dailyRemaining,
  };
}

function isBudgetExpired(budget) {
  return DateTime.fromISO(budget.endDate, { zone: ZONE }) < DateTime.now().setZone(ZONE).startOf("day");
}

function inclusiveDays(startDate, endDate) {
  const start = DateTime.fromISO(startDate, { zone: ZONE }).startOf("day");
  const end = DateTime.fromISO(endDate, { zone: ZONE }).startOf("day");
  return Math.floor(end.diff(start, "days").days) + 1;
}

function daysFromTodayThrough(endDate) {
  const today = DateTime.now().setZone(ZONE).startOf("day");
  const end = DateTime.fromISO(endDate, { zone: ZONE }).startOf("day");
  return Math.max(Math.floor(end.diff(today, "days").days) + 1, 0);
}

function sumAmounts(expenses) {
  return expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
}

function todayIso() {
  return DateTime.now().setZone(ZONE).toISODate();
}

function formatYen(amount) {
  return `${formatNumber(Math.round(amount))}円`;
}

function formatNumber(amount) {
  return Number(amount).toLocaleString("ja-JP");
}

function formatShortDate(isoDate) {
  const date = DateTime.fromISO(isoDate, { zone: ZONE });
  return `${date.month}/${date.day}`;
}

module.exports = {
  buildBudgetReply,
  buildExpenseReply,
  buildRemainingReply,
  buildTodayReply,
  buildListReply,
  calculateStats,
  isBudgetExpired,
  normalizeBudgetPeriod,
};
