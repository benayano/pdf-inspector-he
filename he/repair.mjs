// Repair layer: an LLM works WITH the extractor's result, not instead of it.
//
// The invoice layer (invoice.mjs) reads an invoice and checks its arithmetic.
// Usually every check passes and nothing else is needed. When a few rows or
// a total do not close, sending the whole PDF to a model to read again
// throws away everything that was read right. This module instead:
//
//   1. assess()        says what is wrong: which rows, which totals, and
//                      whether text alone can fix it (a misread cell) or the
//                      model must see the page (a row missing altogether);
//   2. autoRepair()    tries, with no model at all, the same rows from other
//                      readings of the document (another `number_gap`, other
//                      knobs) and keeps a reading only where it closes;
//   3. repairRequest() builds a compact request: a one-line summary of the
//                      totals, the failed checks with their differences, and
//                      ONLY the failing rows (plus a neighbour each side) as
//                      CSV — a few hundred tokens instead of the whole page —
//                      and a JSON schema for the answer;
//   4. applyRepair()   applies the answer row by row, keeps a correction only
//                      if the row then closes, and checks the whole invoice
//                      again. The model never gets the last word: arithmetic
//                      does.
//
// The library calls no model and holds no key: the caller sends the request
// (with the pages attached when `needsPages`) and passes the parsed answer.

import { recheck, invoiceInfo, parseInvoice } from "./invoice.mjs";

const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- assess

/**
 * What is wrong with a parsed invoice, and how it could be fixed.
 * @param {object} invoice parseInvoice() result
 * @param {{maxFailedShare?: number}} [options] a table with more failing rows
 *   than this share (default 0.4) is read wrong as a whole: not repairable.
 */
export function assess(invoice, { maxFailedShare = 0.4 } = {}) {
  const reasons = [];
  const lines = invoice.lines;
  if (!lines || !lines.rows.length) {
    return { status: "unreadable", reasons: ["no item table found"], failedRows: [], failedChecks: [], needsPages: true, pages: [] };
  }
  const failedRows = [];
  lines.rows.forEach((r, i) => {
    if (r.check && !r.check.ok) failedRows.push(i);
  });
  const ran = new Set(invoice.checks.map((c) => c.name));
  const failedChecks = invoice.checks.filter((c) => !c.ok && c.name !== "line-arithmetic");
  if (!ran.has("lines-sum")) reasons.push("no printed total to check the lines against");
  if (failedRows.length) reasons.push(`${failedRows.length} row(s) do not close: quantity x price != total`);
  for (const c of failedChecks) reasons.push(`${c.name} is off by ${c.diff}`);

  // Every row closes but the lines do not add up to the printed total: a row
  // is missing or extra (a page break, a wrapped row). Text alone cannot
  // bring back a row that was never read.
  const linesSum = failedChecks.find((c) => c.name === "lines-sum");
  const missingRow = Boolean(linesSum) && failedRows.length === 0;
  if (missingRow) reasons.push("every row closes but their sum does not: a row is missing or extra");

  const pages = [...new Set(missingRow ? lines.pages : failedRows.map((i) => lines.rows[i].page))].sort((a, b) => a - b);
  let status;
  if (!ran.has("lines-sum")) status = "unreadable";
  else if (!failedRows.length && !failedChecks.length) status = "ok";
  else if (
    failedRows.length > Math.max(3, lines.rows.length * maxFailedShare) ||
    (lines.rows.length >= 2 && failedRows.length === lines.rows.length)
  ) {
    status = "unreadable";
    reasons.push("too many rows fail: the table was read wrong as a whole");
  } else status = "repairable";
  return { status, reasons, failedRows, failedChecks, needsPages: missingRow, pages };
}

// ---------------------------------------------------------------- auto repair

/**
 * Fixes failing rows from other readings of the same document, with no
 * model: for each failing row, the same row of an alternative reading that
 * closes there is taken. "The same row" is the same page and printed line
 * number (or, without a line-number column, the same position on the page),
 * so an alternative may read only the pages with failing rows. A typical
 * source: the document read again with `number_gap` 0.1 / 0.3 / auto, where
 * two numbers that ran together ("31.2" for "1.2 3") come out apart.
 * @param {object} invoice parseInvoice() result
 * @param {object[]} alternatives parseInvoice() results of other readings
 * @returns {{invoice: object, fixed: {row: number, from: number}[]}}
 */
export function autoRepair(invoice, alternatives) {
  const rows = invoice.lines?.rows;
  if (!rows) return { invoice, fixed: [] };
  const keyed = (list) => {
    const seen = new Map();
    return list.map((r) => {
      const n = (seen.get(r.page) ?? 0) + 1;
      seen.set(r.page, n);
      return r.values.index != null ? `${r.page}#${r.values.index}` : `${r.page}@${n}`;
    });
  };
  const keys = keyed(rows);
  const altMaps = alternatives.map((alt) => {
    const list = alt.lines?.rows ?? [];
    const k = keyed(list);
    return new Map(list.map((r, i) => [k[i], r]));
  });
  const fixed = [];
  const next = rows.map((r) => r);
  rows.forEach((row, i) => {
    if (!row.check || row.check.ok) return;
    for (let a = 0; a < altMaps.length; a++) {
      const candidate = altMaps[a].get(keys[i]);
      if (!candidate) continue;
      if (candidate.check?.ok) {
        next[i] = candidate;
        fixed.push({ row: i + 1, from: a });
        break;
      }
    }
  });
  if (!fixed.length) return { invoice, fixed };
  return { invoice: recheck({ ...invoice, lines: { ...invoice.lines, rows: next } }), fixed };
}

// ---------------------------------------------------------------- CSV

/** Columns of the repair CSV; `row` is the position in the table (1-based), the id the answer uses. */
export const REPAIR_COLUMNS = [
  "row",
  "line_no",
  "page",
  "delivery_note",
  "sku",
  "description",
  "quantity",
  "unit",
  "unit_price",
  "discount_pct",
  "net_unit_price",
  "line_total",
  "check",
];

function cell(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The given rows (indexes into invoice.lines.rows) as compact CSV: only the
 * columns a reader of the numbers needs, no repeated invoice fields. The
 * `check` column says "ok" or by how much the row is off.
 */
export function slimCsv(invoice, rowIndexes, { columns = REPAIR_COLUMNS } = {}) {
  const rows = invoice.lines?.rows ?? [];
  const out = [columns.join(",")];
  for (const i of rowIndexes) {
    const r = rows[i];
    if (!r) continue;
    const v = r.values;
    const record = {
      row: i + 1,
      line_no: v.index ?? null,
      page: r.page,
      delivery_note: v.deliveryNote ?? null,
      sku: v.sku ?? null,
      description: v.description ?? null,
      quantity: v.quantity ?? null,
      unit: v.unit ?? null,
      unit_price: v.unitPrice ?? null,
      discount_pct: v.discount ?? null,
      net_unit_price: v.netUnitPrice ?? null,
      line_total: v.total ?? null,
      check: r.check ? (r.check.ok ? "ok" : `off by ${r.check.diff} (expected ${r.check.expected})`) : "",
    };
    out.push(columns.map((c) => cell(record[c])).join(","));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- request

const NUMBER = { type: "number" };

/** JSON schema of the answer (Anthropic structured outputs / any JSON-schema LLM API). */
export const REPAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fixes", "inserts", "unreadable", "notes"],
  properties: {
    fixes: {
      type: "array",
      description: "one entry per listed row you correct; leave out rows that are right",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["row", "quantity", "unit_price", "discount_pct", "line_total", "why"],
        properties: {
          row: { type: "integer", description: "the `row` value from the CSV" },
          quantity: { ...NUMBER, description: "negative only if printed negative (a returned item)" },
          unit_price: { ...NUMBER, description: "price per unit before the line discount, as printed" },
          discount_pct: { ...NUMBER, description: "line discount percent as printed; 0 if none" },
          line_total: { ...NUMBER, description: "the row's printed total" },
          why: { type: "string", description: "one short sentence: what was misread" },
        },
      },
    },
    inserts: {
      type: "array",
      description: "only when page images are attached: rows printed on the page that the CSV lacks",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["after_row", "line_no", "delivery_note", "sku", "description", "quantity", "unit", "unit_price", "discount_pct", "line_total"],
        properties: {
          after_row: { type: "integer", description: "the `row` it follows (0 = before the first)" },
          line_no: { type: "integer", description: "the printed line number; 0 if none" },
          delivery_note: { type: "string" },
          sku: { type: "string" },
          description: { type: "string", description: "as printed, Hebrew in reading order" },
          quantity: NUMBER,
          unit: { type: "string" },
          unit_price: NUMBER,
          discount_pct: NUMBER,
          line_total: NUMBER,
        },
      },
    },
    unreadable: {
      type: "array",
      description: "rows you cannot settle from what you were given",
      items: { type: "integer" },
    },
    notes: { type: "string", description: "anything a person should know; \"\" if nothing" },
  },
};

function totalsLine(invoice) {
  const info = invoiceInfo(invoice);
  const parts = [];
  if (info.invoice_number) parts.push(`invoice ${info.invoice_number}`);
  if (info.invoice_date) parts.push(info.invoice_date);
  for (const t of invoice.totals ?? []) parts.push(`${t.label} = ${t.value}`);
  return parts.join("; ");
}

/**
 * A compact repair request for a model: what failed, and the failing rows
 * with a neighbour on each side as CSV. When `needsPages` the caller must
 * attach the listed pages (a missing row cannot be read from text).
 * @param {object} invoice parseInvoice() (or autoRepair()) result
 * @param {{context?: string, neighbours?: number, maxRows?: number, allRowsUpTo?: number}} [options]
 *   allRowsUpTo: send every row when the table is this short (default 25)
 * @returns {{status: string, prompt: string, schema: object, rows: number[], pages: number[], needsPages: boolean}}
 */
export function repairRequest(invoice, { context = "", neighbours = 1, maxRows = 60, allRowsUpTo = 25 } = {}) {
  const a = assess(invoice);
  const rows = invoice.lines?.rows ?? [];
  let pick = new Set();
  if (a.needsPages || rows.length <= allRowsUpTo) {
    rows.forEach((_, i) => pick.add(i));
  } else {
    for (const i of a.failedRows) {
      for (let j = i - neighbours; j <= i + neighbours; j++) if (j >= 0 && j < rows.length) pick.add(j);
    }
  }
  const indexes = [...pick].sort((x, y) => x - y).slice(0, maxRows);
  const failed = [
    ...a.failedRows.map((i) => `row ${i + 1}: ${rows[i].values.quantity} x price != ${rows[i].values.total} (off by ${rows[i].check.diff})`),
    ...a.failedChecks.map((c) => `${c.name}: printed ${c.actual}, from the rows ${c.expected} (off by ${c.diff})`),
  ];
  const prompt = [
    "An invoice was read by a PDF extractor. Most of it checks; the items below do not.",
    context ? `Context: ${context}` : "",
    "Rows are listed as CSV in reading order. Hebrew text is already in reading order: do not reverse it.",
    "Typical misreads: two adjacent numbers run together or split (\"31.2\" for \"1.2 3\"), a decimal point lost,",
    "a minus sign printed after the number (\"461.54-\"), a quantity printed with its unit.",
    "Correct only what the evidence supports. A row whose printed numbers really disagree is the supplier's",
    "error, not a misread: list it in `unreadable` and do not invent a value.",
    a.needsPages
      ? "The page images are attached: a row seems missing or extra. Compare them with the CSV; add missing rows in `inserts`."
      : "No page images are attached; answer from the CSV only (use `inserts` only if images are attached).",
    "",
    `TOTALS: ${totalsLine(invoice)}`,
    "FAILED:",
    ...failed.map((f) => `- ${f}`),
    "",
    "ROWS:",
    slimCsv(invoice, indexes),
  ].filter((l) => l !== "").join("\n");
  return { status: a.status, prompt, schema: REPAIR_SCHEMA, rows: indexes, pages: a.pages, needsPages: a.needsPages };
}

// ---------------------------------------------------------------- apply

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Applies a model's answer to the invoice. A fix is kept only for a row the
 * request listed and only if the row then closes; an insert only if the
 * request asked for pages and the lines then add up to the printed total.
 * Everything is checked again; nothing is taken on the model's word.
 * @param {object} invoice the invoice the request was built from
 * @param {object} answer the model's JSON (REPAIR_SCHEMA)
 * @param {{rows: number[], needsPages: boolean}} request repairRequest() result
 * @returns {{invoice: object, applied: object[], rejected: object[], status: string, reasons: string[]}}
 */
export function applyRepair(invoice, answer, request) {
  const applied = [];
  const rejected = [];
  const listed = new Set(request.rows);
  let rows = (invoice.lines?.rows ?? []).map((r) => r);

  for (const fix of Array.isArray(answer?.fixes) ? answer.fixes : []) {
    const i = Number(fix?.row) - 1;
    if (!listed.has(i)) {
      rejected.push({ ...fix, reason: "row was not in the request" });
      continue;
    }
    if (![fix.quantity, fix.unit_price, fix.discount_pct, fix.line_total].every(finite)) {
      rejected.push({ ...fix, reason: "not a number" });
      continue;
    }
    const before = rows[i];
    const values = {
      ...before.values,
      quantity: fix.quantity,
      unitPrice: fix.unit_price,
      discount: fix.discount_pct || undefined,
      total: round2(fix.line_total),
    };
    if (values.discount === undefined) delete values.discount;
    delete values.netUnitPrice; // the corrected price stands for both
    const checked = recheck({ ...invoice, lines: { ...invoice.lines, rows: [{ ...before, values }] } }).lines.rows[0];
    if (checked.check && !checked.check.ok) {
      rejected.push({ ...fix, reason: `still off by ${checked.check.diff}` });
      continue;
    }
    rows[i] = { ...checked, repaired: { why: String(fix.why ?? ""), from: before.values } };
    applied.push({ row: i + 1, why: String(fix.why ?? "") });
  }

  const inserts = Array.isArray(answer?.inserts) ? answer.inserts : [];
  if (inserts.length && !request.needsPages) {
    for (const ins of inserts) rejected.push({ ...ins, reason: "no pages were attached; inserts are not taken" });
  } else if (inserts.length) {
    const candidate = [...rows];
    // From the last position back, so earlier `after_row` values stay true.
    const sorted = [...inserts].sort((x, y) => Number(y.after_row) - Number(x.after_row));
    const added = [];
    for (const ins of sorted) {
      if (![ins.quantity, ins.unit_price, ins.discount_pct, ins.line_total].every(finite)) {
        rejected.push({ ...ins, reason: "not a number" });
        continue;
      }
      const at = Math.min(Math.max(Number(ins.after_row) || 0, 0), candidate.length);
      const values = {
        ...(ins.line_no ? { index: ins.line_no } : {}),
        ...(ins.delivery_note ? { deliveryNote: ins.delivery_note } : {}),
        ...(ins.sku ? { sku: ins.sku } : {}),
        description: ins.description,
        quantity: ins.quantity,
        ...(ins.unit ? { unit: ins.unit } : {}),
        unitPrice: ins.unit_price,
        ...(ins.discount_pct ? { discount: ins.discount_pct } : {}),
        total: round2(ins.line_total),
      };
      const page = candidate[Math.max(at - 1, 0)]?.page ?? 1;
      candidate.splice(at, 0, { page, cells: [], amounts: [], values, check: null, inserted: true });
      added.push(ins);
    }
    const trial = recheck({ ...invoice, lines: { ...invoice.lines, rows: candidate } });
    const sum = trial.checks.find((c) => c.name === "lines-sum");
    const rowsOk = trial.lines.rows.every((r) => !r.inserted || !r.check || r.check.ok);
    if (sum?.ok && rowsOk) {
      rows = candidate;
      for (const ins of added) applied.push({ inserted_after: ins.after_row, description: ins.description });
    } else {
      for (const ins of added) rejected.push({ ...ins, reason: "the lines still do not add up with it" });
    }
  }

  const result = recheck({ ...invoice, lines: invoice.lines ? { ...invoice.lines, rows } : null });
  const a = assess(result);
  return { invoice: result, applied, rejected, status: a.status, reasons: a.reasons };
}

// ---------------------------------------------------------------- one call

/** Other readings autoRepair() tries, cheapest first. Each is one knob changed. */
export const DEFAULT_ALTERNATIVES = ["number_gap=0.1", "number_gap=0.3", "number_gap=auto"];

const joinTuning = (...parts) => parts.filter(Boolean).join(",");

/**
 * The whole read in one call: extract (Markdown + positioned items), parse
 * the invoice, and when rows fail try the alternative readings with no
 * model. `pdf` is the pdf-inspector module (wasm or napi) — passed in, so
 * this file runs the same in a browser, Deno, Node or a Supabase function.
 *
 * An engine with `invoiceCall` (wasm and pdf2md from this version on) does
 * the whole read in Rust (src/invoice/, the one implementation, also behind
 * the C ABI for apps); the code below is the JS original it was ported from,
 * kept for older engines and as the oracle (`js: true`, he/tools/goldens.mjs).
 * @param {{processPdf: Function, extractTextWithPositions: Function, invoiceCall?: Function}} pdf
 * @param {Uint8Array} bytes
 * @param {{tuning?: string, alternatives?: string[], pages?: number[], js?: boolean}} [options]
 * @returns {{pdfType: string, invoice: object|null, assessment: object, autoFixed: {row: number, tuning: string}[]}}
 */
export function readInvoice(pdf, bytes, { tuning = "", alternatives = DEFAULT_ALTERNATIVES, pages, js = false } = {}) {
  if (!js && typeof pdf.invoiceCall === "function") {
    const reply = JSON.parse(pdf.invoiceCall("read_invoice", JSON.stringify({ tuning, alternatives, pages, repair_request: false }), bytes));
    if (!reply.ok) throw new Error(reply.error);
    const { state, assessment, auto_fixed, pdf_type } = reply.result;
    return { pdfType: pdf_type, invoice: state?.invoice ?? null, assessment, autoFixed: auto_fixed };
  }
  const r = pdf.processPdf(bytes, { includePageMarkers: true, tuning: tuning || undefined, pages });
  if (r.pdfType !== "TextBased" && r.pdfType !== "Mixed") {
    return {
      pdfType: r.pdfType,
      invoice: null,
      assessment: { status: "unreadable", reasons: [`no text layer (${r.pdfType})`], failedRows: [], failedChecks: [], needsPages: true, pages: [] },
      autoFixed: [],
    };
  }
  const parse = (t, markdown) =>
    parseInvoice({
      markdown,
      items: pdf.extractTextWithPositions(bytes, { tuning: t || undefined, pages }),
    });
  let invoice = parse(tuning, r.markdown);
  let assessment = assess(invoice);
  const autoFixed = [];
  if (assessment.status === "repairable" && assessment.failedRows.length) {
    // Only the pages with failing rows are read again: each reading costs
    // a full parse of what it reads, and a Supabase Edge Function has a
    // CPU budget per request.
    const only = assessment.pages.length ? assessment.pages : pages;
    const others = alternatives.map((alt) => {
      const t = joinTuning(tuning, alt);
      const markdown = pdf.processPdf(bytes, { includePageMarkers: true, tuning: t, pages: only }).markdown;
      const items = pdf.extractTextWithPositions(bytes, { tuning: t, pages: only });
      return { t, inv: parseInvoice({ markdown, items }) };
    });
    const out = autoRepair(invoice, others.map((o) => o.inv));
    if (out.fixed.length) {
      invoice = out.invoice;
      for (const f of out.fixed) autoFixed.push({ row: f.row, tuning: others[f.from].t });
      assessment = assess(invoice);
    }
  }
  return { pdfType: r.pdfType, invoice, assessment, autoFixed };
}
