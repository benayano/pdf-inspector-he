// The invoice as ONE JSON document: what a program (or an agent tool, or a
// database import) gets back from a read, with a stable versioned shape
// (`schema`), described in invoice-document.schema.json.
//
//   const read = readInvoice(pdf, bytes);           // repair.mjs
//   const doc = invoiceDocument(read);              // this file
//
// Lines carry only line fields (the invoice's own facts are once, in
// `invoice`); every line says whether its arithmetic closes; a repaired
// line says why. `repair` holds the compact request a model would get, so a
// caller can send it without building anything.
import { invoiceInfo, toRecords } from "./invoice.mjs";
import { assess, repairRequest } from "./repair.mjs";

export const DOCUMENT_SCHEMA = "pdf-inspector-he/invoice-document@1";

/** Line fields of a document line, in order (the invoice-level fields of toRecords are left out). */
export const LINE_FIELDS = [
  "row",
  "line_no",
  "page",
  "date",
  "delivery_note",
  "order_ref",
  "sku",
  "description",
  "site_text",
  "quantity",
  "unit",
  "unit_price",
  "discount_pct",
  "net_unit_price",
  "line_total",
  "currency",
  "marker",
  "is_return",
  "check_ok",
  "check_diff",
];

/**
 * @param {{pdfType?: string, invoice: object|null, assessment?: object, autoFixed?: object[]}} read
 *   readInvoice() result (or { invoice } after applyRepair)
 * @param {{markdown?: string, repairRequest?: boolean, context?: string}} [options]
 *   markdown: include the extracted Markdown; repairRequest (default true):
 *   include the request for a repairable invoice
 */
export function invoiceDocument(read, { markdown, repairRequest: withRequest = true, context = "" } = {}) {
  const invoice = read.invoice ?? null;
  const assessment = read.assessment ?? (invoice ? assess(invoice) : null);
  const doc = {
    schema: DOCUMENT_SCHEMA,
    pdf: { type: read.pdfType ?? null, pages: invoice?.lines?.pages ?? [] },
    status: assessment?.status ?? "unreadable",
    reasons: assessment?.reasons ?? [],
    invoice: null,
    details: null,
    header: { fields: [], blocks: [] },
    totals: [],
    columns: [],
    lines: [],
    checks: [],
    failed_rows: [],
    auto_fixed: read.autoFixed ?? [],
    repaired: [],
    repair: null,
  };
  if (!invoice) return markdown != null ? { ...doc, markdown } : doc;

  const info = invoiceInfo(invoice);
  const { checks_ok, ...facts } = info;
  doc.invoice = { ...facts, checks_ok };
  // Read by the Rust layer (src/invoice/details.rs); absent in a JS-only read.
  doc.details = invoice.details ?? null;
  doc.header = {
    fields: (invoice.header?.fields ?? []).map(({ label, value }) => ({ label, value })),
    blocks: (invoice.header?.blocks ?? []).map((b) => ({ page: b.page, text: b.text })),
  };
  doc.totals = (invoice.totals ?? []).map(({ label, role, value, percent, currency }) => ({
    label,
    role,
    value,
    percent: percent ?? null,
    currency: currency ?? null,
  }));
  doc.columns = (invoice.lines?.columns ?? []).map(({ name, role }) => ({ name, role: role ?? null }));
  const rows = invoice.lines?.rows ?? [];
  doc.lines = toRecords(invoice).map((r, i) => {
    const line = { row: i + 1 };
    for (const f of LINE_FIELDS.slice(1)) line[f] = r[f] ?? null;
    if (rows[i]?.repaired) line.repaired = rows[i].repaired.why || true;
    if (rows[i]?.inserted) line.inserted = true;
    return line;
  });
  doc.repaired = doc.lines.filter((l) => l.repaired || l.inserted).map((l) => l.row);
  doc.checks = (invoice.checks ?? []).map((c) => {
    const { name, ok, expected, actual, diff } = c;
    const out = { name, ok };
    if (expected !== undefined) out.expected = expected;
    if (actual !== undefined) out.actual = actual;
    if (diff !== undefined) out.diff = diff;
    if (c.label) out.label = c.label;
    if (c.sign) out.sign = c.sign;
    return out;
  });
  doc.failed_rows = (assessment?.failedRows ?? []).map((i) => i + 1);
  if (withRequest && assessment?.status === "repairable") {
    const req = repairRequest(invoice, { context });
    doc.repair = { needs_pages: req.needsPages, pages: req.pages, rows: req.rows.map((i) => i + 1), prompt: req.prompt, schema: req.schema };
  }
  if (markdown != null) doc.markdown = markdown;
  return doc;
}
