import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseInvoice, recheck } from "./invoice.mjs";
import { assess, autoRepair, slimCsv, repairRequest, applyRepair, REPAIR_SCHEMA } from "./repair.mjs";

const item = (text, x, y, width) => ({ text, page: 1, x, y, width, height: 8, fontSize: 8 });

/** Three rows and a totals box: 3,833.31 + 1,210.10 + 66.10 = 5,109.51. */
function invoice(rowTwo = "|2|SH1|מסילה לפאנל|10.00 מטר|121.01 ש\"ח||1,210.10|") {
  const markdown = [
    "||תעודה|תאור מוצר|כמות|מחיר ליחידה|הנחה|סה\"כ מחיר|",
    "|---|---|---|---|---|---|---|",
    "|1|SH1|פאנל קיר|60.80 מטר|101.69 ש\"ח|38.00%|3,833.31|",
    rowTwo,
    "|3|SH2|ברגים|10.00 יח'|6.61 ש\"ח||66.10|",
  ].join("\n");
  const items = [
    item("ספק בע\"מ", 470, 800, 100),
    item("עוסק מורשה: 512345678", 470, 790, 100),
    item("תאריך חשבונית: 31/08/26", 82, 760, 84),
    item("מספר תעודה: SI1", 82, 750, 84),
    item("תאור מוצר", 330, 700, 40),
    item("סה\"כ מחיר", 100, 700, 30),
    item("3,833.31", 100, 690, 30),
    item("66.10", 100, 670, 30),
    item("מחיר כולל", 205, 640, 30),
    item("5,109.51", 100, 640, 30),
    item("מע\"מ (18.00%)", 205, 630, 30),
    item("919.71", 100, 630, 30),
    item("סה\"כ", 205, 620, 30),
    item("6,029.22", 100, 620, 30),
  ];
  return parseInvoice({ markdown, items });
}

// "10.00 מטר" read as "1.00 מטר": the row no longer closes.
const MISREAD = "|2|SH1|מסילה לפאנל|1.00 מטר|121.01 ש\"ח||1,210.10|";

test("a clean invoice is ok and needs no request", () => {
  const a = assess(invoice());
  assert.equal(a.status, "ok");
  assert.deepEqual(a.failedRows, []);
});

test("a misread row is repairable, from text alone", () => {
  const a = assess(invoice(MISREAD));
  assert.equal(a.status, "repairable");
  assert.deepEqual(a.failedRows, [1]);
  assert.equal(a.needsPages, false);
});

test("the request carries only what is needed, as compact CSV", () => {
  const req = repairRequest(invoice(MISREAD), { allRowsUpTo: 0, neighbours: 0 });
  assert.deepEqual(req.rows, [1]);
  assert.match(req.prompt, /row 2: 1 x price != 1210.1/);
  assert.match(req.prompt, /TOTALS: invoice SI1; 2026-08-31; מחיר כולל = 5109.51/);
  const csv = req.prompt.slice(req.prompt.indexOf("ROWS:\n") + 6);
  assert.equal(csv.split("\n").length, 2, "a header and the one failing row");
  assert.match(csv, /^row,line_no,page,delivery_note,sku,description,quantity,unit,unit_price/);
  assert.match(csv, /\n2,2,1,SH1,,מסילה לפאנל,1,מטר,121.01,,,1210.1,off by/);
  assert.equal(req.schema, REPAIR_SCHEMA);
  // Short tables go whole (the neighbours give the model context for free).
  assert.equal(repairRequest(invoice(MISREAD)).rows.length, 3);
});

test("a correction is kept only if the row then closes", () => {
  const broken = invoice(MISREAD);
  const req = repairRequest(broken);
  const good = applyRepair(broken, {
    fixes: [{ row: 2, quantity: 10, unit_price: 121.01, discount_pct: 0, line_total: 1210.1, why: "decimal point" }],
    inserts: [], unreadable: [], notes: "",
  }, req);
  assert.equal(good.status, "ok");
  assert.deepEqual(good.applied, [{ row: 2, why: "decimal point" }]);
  assert.equal(good.invoice.lines.rows[1].values.quantity, 10);
  assert.equal(good.invoice.lines.rows[1].repaired.from.quantity, 1);

  const wrong = applyRepair(broken, {
    fixes: [{ row: 2, quantity: 9, unit_price: 121.01, discount_pct: 0, line_total: 1210.1, why: "guess" }],
    inserts: [], unreadable: [], notes: "",
  }, req);
  assert.equal(wrong.status, "repairable");
  assert.equal(wrong.applied.length, 0);
  assert.match(wrong.rejected[0].reason, /still off/);

  const outside = applyRepair(broken, {
    fixes: [{ row: 7, quantity: 1, unit_price: 1, discount_pct: 0, line_total: 1, why: "" }],
    inserts: [], unreadable: [], notes: "",
  }, req);
  assert.match(outside.rejected[0].reason, /not in the request/);
});

test("a missing row needs the page, and an insert is kept only if the sum closes", () => {
  // Row 2 never read: every remaining row closes, the sum does not.
  const full = invoice();
  const rows = full.lines.rows.filter((_, i) => i !== 1);
  const missing = recheck({ ...full, lines: { ...full.lines, rows } });
  const a = assess(missing);
  assert.equal(a.status, "repairable");
  assert.equal(a.needsPages, true);
  assert.deepEqual(a.pages, [1]);

  const req = repairRequest(missing);
  assert.equal(req.needsPages, true);
  const row = { after_row: 1, line_no: 2, delivery_note: "SH1", sku: "", description: "מסילה לפאנל", quantity: 10, unit: "מטר", unit_price: 121.01, discount_pct: 0, line_total: 1210.1 };
  const fixed = applyRepair(missing, { fixes: [], inserts: [row], unreadable: [], notes: "" }, req);
  assert.equal(fixed.status, "ok");
  assert.equal(fixed.invoice.lines.rows[1].values.description, "מסילה לפאנל");

  const off = applyRepair(missing, { fixes: [], inserts: [{ ...row, quantity: 1, line_total: 121.01 }], unreadable: [], notes: "" }, req);
  assert.equal(off.status, "repairable");
  assert.match(off.rejected[0].reason, /do not add up/);

  // Without pages, inserts are refused outright.
  const textOnly = applyRepair(missing, { fixes: [], inserts: [row], unreadable: [], notes: "" }, { ...req, needsPages: false });
  assert.match(textOnly.rejected[0].reason, /no pages were attached/);
});

test("autoRepair takes a row from another reading only where it closes", () => {
  const broken = invoice(MISREAD);
  const other = invoice(); // e.g. the same PDF read with another number_gap
  const { invoice: fixed, fixed: which } = autoRepair(broken, [other]);
  assert.deepEqual(which, [{ row: 2, from: 0 }]);
  assert.equal(assess(fixed).status, "ok");
  // An alternative that is wrong there too changes nothing.
  assert.deepEqual(autoRepair(broken, [invoice(MISREAD)]).fixed, []);
});

test("a table read wrong as a whole is not repairable", () => {
  const bad = invoice();
  const rows = bad.lines.rows.map((r) => ({ ...r, values: { ...r.values, total: r.values.total + 5 } }));
  assert.equal(assess(recheck({ ...bad, lines: { ...bad.lines, rows } })).status, "unreadable");
  assert.equal(assess({ lines: null, checks: [] }).status, "unreadable");
});

test("slimCsv quotes and keeps the row id", () => {
  const csv = slimCsv(invoice(), [0], { columns: ["row", "description"] });
  assert.equal(csv, "row,description\n1,פאנל קיר");
});

// A corpus invoice, one row damaged the way a misread damages it.
const pdf2md = fileURLToPath(new URL("../target/release/pdf2md", import.meta.url));
const corpus = fileURLToPath(new URL("./fixtures/invoices/print-to-pdf-5p.pdf", import.meta.url));
test("on a real 162-row invoice the request stays a few hundred tokens", { skip: !existsSync(pdf2md) }, () => {
  const markdown = execFileSync(pdf2md, ["--raw", "--pages", corpus]).toString();
  const items = JSON.parse(execFileSync(pdf2md, ["--items-json", corpus]).toString());
  const real = parseInvoice({ markdown, items });
  assert.equal(assess(real).status, "ok");
  const rows = real.lines.rows.map((r) => r);
  rows[40] = { ...rows[40], values: { ...rows[40].values, quantity: rows[40].values.quantity * 10 } };
  const damaged = recheck({ ...real, lines: { ...real.lines, rows } });
  const req = repairRequest(damaged);
  assert.equal(req.status, "repairable");
  assert.deepEqual(req.rows, [39, 40, 41]);
  assert.ok(req.prompt.length < 2000, `prompt is ${req.prompt.length} chars`);
  const answer = { fixes: [{ row: 41, quantity: real.lines.rows[40].values.quantity, unit_price: real.lines.rows[40].values.unitPrice, discount_pct: real.lines.rows[40].values.discount ?? 0, line_total: real.lines.rows[40].values.total, why: "x10" }], inserts: [], unreadable: [], notes: "" };
  assert.equal(applyRepair(damaged, answer, req).status, "ok");
});

test("autoRepair matches a reading of the failing page alone", () => {
  const broken = invoice(MISREAD);
  const full = invoice();
  // A reading of page 1 only, with its rows in another order than the table:
  // matched by page and printed line number, not by position.
  const onlyRowTwo = { ...full, lines: { ...full.lines, rows: [full.lines.rows[1]] } };
  const out = autoRepair(broken, [onlyRowTwo]);
  assert.deepEqual(out.fixed, [{ row: 2, from: 0 }]);
  assert.equal(assess(out.invoice).status, "ok");
});
