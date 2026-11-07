import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAmount,
  splitField,
  markdownTables,
  mergeTables,
  lineItems,
  headerBlocks,
  parseInvoice,
} from "./invoice.mjs";

test("parseAmount reads the ways invoices print amounts", () => {
  const v = (t) => parseAmount(t)?.value;
  assert.equal(v("1,210.10"), 1210.1);
  assert.equal(v("461.54-"), -461.54);
  assert.equal(v("-461.54"), -461.54);
  assert.equal(v("0.32-"), -0.32);
  assert.deepEqual(
    (({ value, unit, currency }) => ({ value, unit, currency }))(parseAmount('101.69 ש"ח')),
    { value: 101.69, unit: 'ש"ח', currency: "ILS" },
  );
  assert.equal(parseAmount("60.80 מטר").unit, "מטר");
  assert.equal(parseAmount("1.00- יח'").value, -1);
  assert.equal(parseAmount("1.00- יח'").unit, "יח'");
  assert.equal(parseAmount("0.67 ק'ג").value, 0.67);
  const pct = parseAmount("38.00%");
  assert.equal(pct.value, 38);
  assert.equal(pct.percent, true);
  assert.equal(parseAmount("(0.04%-)").value, -0.04);
  assert.equal(parseAmount("₪ 12.5").currency, "ILS");
  for (const no of ["23/10/22", "SH22039076", "LK-1144501", "מסילה 1.2 3 מטר", "", "21:01", "-5-"]) {
    assert.equal(parseAmount(no), null, no);
  }
});

test("splitField splits labels, mirrored Latin labels, and leaves times alone", () => {
  assert.deepEqual(splitField("תאריך חשבונית: 31/08/26"), { label: "תאריך חשבונית", value: "31/08/26" });
  assert.deepEqual(splitField("ori@x.com :Email"), { label: "Email", value: "ori@x.com" });
  assert.deepEqual(splitField("לכבוד:"), { label: "לכבוד", value: "" });
  assert.equal(splitField("21:01"), null);
  assert.equal(splitField("בלי נקודתיים"), null);
});

const twoPages = [
  "<!-- Page 1 -->",
  "",
  "||תאור מוצר|כמות|מחיר ליחידה|הנחה|סה\"כ מחיר|",
  "|---|---|---|---|---|---|",
  "|1|פאנל קיר|60.80 מטר|101.69 ש\"ח|38.00%|3,833.31|",
  "|2|מסילה|28.00 יח'|72.03 ש\"ח|40.00%|1,210.10|",
  "",
  "<!-- Page 2 -->",
  "",
  "||תאור מוצר|כמות|מחיר ליחידה|הנחה|סה\"כ מחיר|",
  "|---|---|---|---|---|---|",
  "|3|ברגי גבס במשקל|0.67 ק'ג|68.38 ש\"ח|28.00%|32.79|",
  "|4|זיכוי|1.00- יח'|461.54 ש\"ח||461.54-|",
  "",
  "||מחיר כולל|4,614.66|",
  "|---|---|---|",
].join("\n");

test("tables with the same header and running numbers merge across pages", () => {
  const tables = markdownTables(twoPages);
  assert.equal(tables.length, 3);
  assert.deepEqual(tables.map((t) => t.page), [1, 2, 2]);
  const merged = mergeTables(tables);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].rows.length, 4);
  assert.deepEqual(merged[0].pages, [1, 2]);
});

test("a table whose numbering restarts is a new table", () => {
  const restart = twoPages.replace("|3|", "|1|").replace("|4|", "|2|");
  assert.equal(mergeTables(markdownTables(restart)).length, 3);
});

test("lineItems normalizes cells and checks every row's arithmetic", () => {
  const lines = lineItems(twoPages);
  assert.deepEqual(
    lines.columns.map((c) => c.role),
    ["index", "description", "quantity", "unitPrice", "discount", "total"],
  );
  assert.equal(lines.rows.length, 4);
  const [first, , kilo, credit] = lines.rows;
  assert.deepEqual(first.values, {
    index: 1,
    description: "פאנל קיר",
    quantity: 60.8,
    unit: "מטר",
    unitPrice: 101.69,
    discount: 38,
    total: 3833.31,
  });
  assert.equal(first.check.ok, true);
  assert.equal(kilo.check.ok, true, "a rounded quantity (2/3 kg) is within tolerance");
  assert.equal(credit.values.quantity, -1);
  assert.equal(credit.check.ok, true, "a credit line: -1 x 461.54 = 461.54-");
});

test("a row whose total disagrees with its arithmetic is reported", () => {
  const wrong = twoPages.replace("|1,210.10|", "|1,120.10|");
  const bad = lineItems(wrong).rows[1].check;
  assert.equal(bad.ok, false);
  assert.equal(bad.diff, -90);
});

const item = (text, x, y, width, extra = {}) => ({ text, page: 1, x, y, width, height: 8, fontSize: 8, ...extra });

test("headerBlocks keeps side-by-side blocks apart", () => {
  const items = [
    item("לכבוד:", 564, 746, 20),
    item("תאריך חשבונית: 31/10/22", 82, 746, 84),
    item("לקוח בע\"מ", 540, 737, 45),
    item("תאריך הדפסה: 07/11/22", 87, 737, 79),
    item("טלפון: 0500000000", 521, 728, 63),
    item("שעת הדפסה: 18:39", 102, 728, 63),
  ];
  const blocks = headerBlocks(items, true);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].lines, ["לכבוד:", "לקוח בע\"מ", "טלפון: 0500000000"]);
  assert.deepEqual(blocks[1].lines, [
    "תאריך חשבונית: 31/10/22",
    "תאריך הדפסה: 07/11/22",
    "שעת הדפסה: 18:39",
  ]);
  assert.deepEqual(
    blocks[1].fields.map((f) => [f.label, f.value]),
    [
      ["תאריך חשבונית", "31/10/22"],
      ["תאריך הדפסה", "07/11/22"],
      ["שעת הדפסה", "18:39"],
    ],
  );
});

test("parseInvoice reads the totals box and checks it against the lines", () => {
  const markdown = [
    "||תאור מוצר|כמות|מחיר ליחידה|הנחה|סה\"כ מחיר|",
    "|---|---|---|---|---|---|",
    "|1|פאנל קיר|60.80 מטר|101.69 ש\"ח|38.00%|3,833.31|",
    "|2|מסילה|28.00 יח'|72.03 ש\"ח|40.00%|1,210.10|",
  ].join("\n");
  const items = [
    item("לכבוד:", 564, 760, 20),
    item("תאריך חשבונית: 31/10/22", 82, 760, 84),
    item("תאור מוצר", 330, 700, 40),
    item("סה\"כ מחיר", 100, 700, 30),
    item("1", 570, 690, 4),
    item("3,833.31", 100, 690, 30),
    item("2", 570, 680, 4),
    item("1,210.10", 100, 680, 30),
    item("מחיר כולל", 205, 660, 30, { isBold: true }),
    item("5,043.41", 100, 660, 30),
    item("הנחה כללית (0.00%)", 170, 650, 60),
    item("0.41", 105, 650, 20),
    item("מחיר אחרי הנחה", 183, 640, 50),
    item("5,043.00", 100, 640, 30),
    item("מע\"מ (18.00%)", 183, 630, 50),
    item("907.74", 100, 630, 30),
    item("סה\"כ מחיר", 183, 620, 50),
    item("5,950.74 ש\"ח", 90, 620, 40),
    // A vertical stamp in the margin is not a header line.
    item("הופק באמצעות מערכת", 55, 577, 5, { height: 98, fontSize: 5, rotation: 270 }),
  ];
  const inv = parseInvoice({ markdown, items });
  assert.equal(inv.rtl, true);
  assert.deepEqual(
    inv.totals.map((t) => [t.role, t.value]),
    [
      ["subtotal", 5043.41],
      ["discount", 0.41],
      ["afterDiscount", 5043],
      ["vat", 907.74],
      ["total", 5950.74],
    ],
  );
  const byName = Object.fromEntries(inv.checks.map((c) => [c.name, c]));
  assert.equal(byName["lines-sum"].ok, true);
  assert.equal(byName["line-arithmetic"].ok, true);
  assert.equal(byName.discount.sign, "minus");
  assert.equal(byName.vat.ok, true);
  assert.equal(byName["grand-total"].ok, true);
  assert.deepEqual(
    inv.header.blocks.map((b) => b.lines),
    [["לכבוד:"], ["תאריך חשבונית: 31/10/22"]],
  );
});

test("parseInvoice says so when the totals do not add up", () => {
  const markdown = "||תאור מוצר|כמות|מחיר ליחידה|סה\"כ מחיר|\n|---|---|---|---|---|\n|1|א|2.00 יח'|10.00|20.00|";
  const items = [
    item("סה\"כ מחיר", 100, 700, 30),
    item("20.00", 100, 690, 30),
    item("מחיר כולל", 205, 660, 30),
    item("25.00", 100, 660, 30),
  ];
  const sum = parseInvoice({ markdown, items }).checks.find((c) => c.name === "lines-sum");
  assert.equal(sum.ok, false);
  assert.equal(sum.diff, 5);
});
