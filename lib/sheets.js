const { google } = require("googleapis");
const { DateTime } = require("luxon");

const BUDGETS_SHEET = "budgets";
const EXPENSES_SHEET = "expenses";
const BUDGET_HEADERS = ["userId", "startDate", "endDate", "totalBudget", "createdAt", "updatedAt"];
const EXPENSE_HEADERS = ["userId", "date", "itemName", "amount", "rawMessage", "createdAt"];

let sheetsClient;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

async function ensureSheets() {
  if (useWebApp()) {
    await callWebApp("ensureSheets", {});
    return;
  }

  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = new Set(meta.data.sheets.map((sheet) => sheet.properties.title));
  const requests = [];

  if (!existing.has(BUDGETS_SHEET)) {
    requests.push({ addSheet: { properties: { title: BUDGETS_SHEET } } });
  }
  if (!existing.has(EXPENSES_SHEET)) {
    requests.push({ addSheet: { properties: { title: EXPENSES_SHEET } } });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }

  await ensureHeader(BUDGETS_SHEET, BUDGET_HEADERS);
  await ensureHeader(EXPENSES_SHEET, EXPENSE_HEADERS);
}

async function ensureHeader(sheetName, headers) {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const range = `${sheetName}!1:1`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range }).catch(() => null);
  const values = current?.data?.values?.[0] || [];

  if (headers.some((header, index) => values[index] !== header)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1:${columnName(headers.length)}1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
  }
}

async function getBudget(userId) {
  if (useWebApp()) {
    const response = await callWebApp("getBudget", { userId });
    return response.budget;
  }

  const rows = await getRows(BUDGETS_SHEET);
  const row = rows.find((candidate) => candidate.userId === userId);
  if (!row) return null;

  return {
    userId: row.userId,
    startDate: row.startDate,
    endDate: row.endDate,
    totalBudget: Number(row.totalBudget),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function upsertBudget(budget) {
  if (useWebApp()) {
    await callWebApp("upsertBudget", { budget });
    return;
  }

  const now = nowIso();
  const rows = await getRows(BUDGETS_SHEET, true);
  const existing = rows.find((row) => row.userId === budget.userId);
  const values = [
    budget.userId,
    budget.startDate,
    budget.endDate,
    budget.totalBudget,
    existing?.createdAt || now,
    now,
  ];

  if (existing) {
    await updateRow(BUDGETS_SHEET, existing.rowNumber, values);
  } else {
    await appendRow(BUDGETS_SHEET, values);
  }
}

async function appendExpense(expense) {
  if (useWebApp()) {
    await callWebApp("appendExpense", { expense });
    return;
  }

  await appendRow(EXPENSES_SHEET, [
    expense.userId,
    expense.date,
    expense.itemName,
    expense.amount,
    expense.rawMessage,
    nowIso(),
  ]);
}

async function listExpenses(userId, startDate, endDate) {
  if (useWebApp()) {
    const response = await callWebApp("listExpenses", { userId, startDate, endDate });
    return response.expenses || [];
  }

  const rows = await getRows(EXPENSES_SHEET);
  return rows
    .filter((row) => row.userId === userId && row.date >= startDate && row.date <= endDate)
    .map((row) => ({
      userId: row.userId,
      date: row.date,
      itemName: row.itemName,
      amount: Number(row.amount),
      rawMessage: row.rawMessage,
      createdAt: row.createdAt,
    }))
    .sort((a, b) => `${a.date} ${a.createdAt}`.localeCompare(`${b.date} ${b.createdAt}`));
}

async function resetUserData(userId) {
  if (useWebApp()) {
    await callWebApp("resetUserData", { userId });
    return;
  }

  await rewriteWithoutUser(BUDGETS_SHEET, BUDGET_HEADERS, userId);
  await rewriteWithoutUser(EXPENSES_SHEET, EXPENSE_HEADERS, userId);
}

function useWebApp() {
  return Boolean(process.env.SHEETS_WEBAPP_URL);
}

async function callWebApp(action, payload) {
  const response = await fetch(process.env.SHEETS_WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action,
      secret: process.env.SHEETS_WEBAPP_SECRET,
      ...payload,
    }),
  });

  if (!response.ok) {
    throw new Error(`Sheets Web App HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || "Sheets Web App error");
  }

  return data;
}

async function rewriteWithoutUser(sheetName, headers, userId) {
  const rows = await getRows(sheetName);
  const kept = rows.filter((row) => row.userId !== userId);
  const values = [headers, ...kept.map((row) => headers.map((header) => row[header] || ""))];
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${sheetName}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

async function getRows(sheetName, includeRowNumber = false) {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
  });

  const [headers, ...dataRows] = response.data.values || [[]];
  return dataRows
    .filter((row) => row.some((cell) => cell !== ""))
    .map((row, index) => {
      const object = Object.fromEntries(headers.map((header, column) => [header, row[column] || ""]));
      if (includeRowNumber) object.rowNumber = index + 2;
      return object;
    });
}

async function appendRow(sheetName, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
}

async function updateRow(sheetName, rowNumber, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${sheetName}!A${rowNumber}:${columnName(values.length)}${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

function columnName(index) {
  let name = "";
  while (index > 0) {
    const modulo = (index - 1) % 26;
    name = String.fromCharCode(65 + modulo) + name;
    index = Math.floor((index - modulo) / 26);
  }
  return name;
}

function nowIso() {
  return DateTime.now().setZone("Asia/Tokyo").toISO();
}

module.exports = {
  ensureSheets,
  getBudget,
  upsertBudget,
  appendExpense,
  listExpenses,
  resetUserData,
};
