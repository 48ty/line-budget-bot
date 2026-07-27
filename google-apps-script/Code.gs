const SECRET = "CHANGE_ME_TO_A_RANDOM_SECRET";
const BUDGETS_SHEET = "budgets";
const EXPENSES_SHEET = "expenses";
const BUDGET_HEADERS = ["userId", "startDate", "endDate", "totalBudget", "createdAt", "updatedAt"];
const EXPENSE_HEADERS = ["userId", "date", "itemName", "amount", "rawMessage", "createdAt", "category"];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return json({ ok: false, error: "unauthorized" });

    ensureSheets();

    if (body.action === "ensureSheets") return json({ ok: true });
    if (body.action === "getBudget") return json({ ok: true, budget: getBudget(body.userId) });
    if (body.action === "upsertBudget") return json({ ok: true, budget: upsertBudget(body.budget) });
    if (body.action === "appendExpense") return json({ ok: true, expense: appendExpense(body.expense) });
    if (body.action === "listExpenses") {
      return json({ ok: true, expenses: listExpenses(body.userId, body.startDate, body.endDate) });
    }
    if (body.action === "deleteLastExpense") {
      return json({ ok: true, expense: deleteLastExpense(body.userId, body.startDate, body.endDate) });
    }
    if (body.action === "updateLastExpense") {
      return json({ ok: true, result: updateLastExpense(body.userId, body.startDate, body.endDate, body.changes) });
    }
    if (body.action === "resetUserData") return json({ ok: true, result: resetUserData(body.userId) });

    return json({ ok: false, error: "unknown_action" });
  } catch (error) {
    return json({ ok: false, error: String(error) });
  }
}

function ensureSheets() {
  ensureSheet(BUDGETS_SHEET, BUDGET_HEADERS);
  ensureSheet(EXPENSES_SHEET, EXPENSE_HEADERS);
}

function ensureSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const mismatch = headers.some((header, index) => current[index] !== header);
  if (mismatch) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function getBudget(userId) {
  return rowsToObjects(BUDGETS_SHEET).find((row) => row.userId === userId) || null;
}

function upsertBudget(budget) {
  const now = new Date().toISOString();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BUDGETS_SHEET);
  const rows = rowsToObjects(BUDGETS_SHEET, true);
  const existing = rows.find((row) => row.userId === budget.userId);
  const values = [budget.userId, budget.startDate, budget.endDate, budget.totalBudget, existing ? existing.createdAt : now, now];

  if (existing) sheet.getRange(existing.rowNumber, 1, 1, values.length).setValues([values]);
  else sheet.appendRow(values);

  return budget;
}

function appendExpense(expense) {
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EXPENSES_SHEET).appendRow([
    expense.userId,
    expense.date,
    expense.itemName,
    expense.amount,
    expense.rawMessage,
    new Date().toISOString(),
    expense.category || "",
  ]);
  return expense;
}

function listExpenses(userId, startDate, endDate) {
  return rowsToObjects(EXPENSES_SHEET)
    .filter((row) => row.userId === userId && row.date >= startDate && row.date <= endDate)
    .map(normalizeExpense)
    .sort((a, b) => `${a.date} ${a.createdAt}`.localeCompare(`${b.date} ${b.createdAt}`));
}

function deleteLastExpense(userId, startDate, endDate) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EXPENSES_SHEET);
  const latest = rowsToObjects(EXPENSES_SHEET, true)
    .filter((row) => row.userId === userId && row.date >= startDate && row.date <= endDate)
    .sort((a, b) => `${b.date} ${b.createdAt}`.localeCompare(`${a.date} ${a.createdAt}`))[0];
  if (!latest) return null;

  sheet.deleteRow(latest.rowNumber);
  return normalizeExpense(latest);
}

function updateLastExpense(userId, startDate, endDate, changes) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EXPENSES_SHEET);
  const latest = rowsToObjects(EXPENSES_SHEET, true)
    .filter((row) => row.userId === userId && row.date >= startDate && row.date <= endDate)
    .sort((a, b) => `${b.date} ${b.createdAt}`.localeCompare(`${a.date} ${a.createdAt}`))[0];
  if (!latest) return null;

  const before = normalizeExpense(latest);
  const after = normalizeExpense(Object.assign({}, latest, changes || {}));
  const values = EXPENSE_HEADERS.map((header) => after[header] || "");
  sheet.getRange(latest.rowNumber, 1, 1, values.length).setValues([values]);
  return { before, after };
}

function resetUserData(userId) {
  rewriteWithoutUser(BUDGETS_SHEET, BUDGET_HEADERS, userId);
  rewriteWithoutUser(EXPENSES_SHEET, EXPENSE_HEADERS, userId);
  return true;
}

function rewriteWithoutUser(sheetName, headers, userId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const kept = rowsToObjects(sheetName).filter((row) => row.userId !== userId);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (kept.length > 0) {
    sheet.getRange(2, 1, kept.length, headers.length).setValues(
      kept.map((row) => headers.map((header) => row[header] || ""))
    );
  }
}

function rowsToObjects(sheetName, includeRowNumber) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0];
  return values.slice(1).filter((row) => row.some((cell) => cell !== "")).map((row, index) => {
    const object = {};
    headers.forEach((header, column) => {
      object[header] = row[column] instanceof Date
        ? Utilities.formatDate(row[column], "Asia/Tokyo", header === "date" ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ssXXX")
        : String(row[column] || "");
    });
    if (includeRowNumber) object.rowNumber = index + 2;
    return object;
  });
}

function normalizeExpense(row) {
  return {
    userId: row.userId,
    date: row.date,
    itemName: row.itemName,
    amount: Number(row.amount),
    rawMessage: row.rawMessage,
    createdAt: row.createdAt,
    category: row.category || "",
  };
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
