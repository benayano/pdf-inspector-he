// pdf-inspector-he as TOOLS for an LLM agent — the agent is the model that
// repairs, so no second model is called: it reads the invoice, sees exactly
// which rows do not close, corrects them with fix_rows, and the arithmetic
// (not the model) decides whether a correction is kept.
//
//   const agent = createInvoiceAgent({ engine, readFile, writeFile });
//   agent.tools          // Anthropic tool definitions (agent.mcpTools for MCP)
//   agent.instructions   // text for the system prompt
//   await agent.call("read_invoice", { file: "a.pdf" })   // -> { ok, result }
//
// Transport-neutral and dependency-free: no fs, no network. The host passes
// the engine (wasm or native, engines.mjs) and how a `file` name becomes
// bytes, so the same tools serve an in-process agent, the MCP server
// (mcp-server.mjs) and a Supabase function. State (the invoice as repaired so
// far) is kept per file for the life of the agent object.
import { toCsv, toRecords } from "./invoice.mjs";
import { applyRepair, assess, readInvoice, slimCsv } from "./repair.mjs";
import { invoiceDocument } from "./document.mjs";

export const INVOICE_AGENT_INSTRUCTIONS = `You can read supplier invoices (PDF, Hebrew / right-to-left included) with the invoice tools.
- Start with read_invoice. If status is "ok", every row and total closes: use the numbers as they are.
- If status is "repairable", the failing rows are listed as CSV with how far each is off. Decide from the row,
  its neighbours and, if needed, extract_text of that page, what was misread (two numbers run together, a lost
  decimal point, a minus printed after the number). Send corrections with fix_rows. A correction is kept only if
  the row's quantity x price then equals its total; read the rejected reasons and do not loop more than twice.
- A row whose printed numbers really disagree is the supplier's error, not a misread: report it, do not invent a value.
- If a row seems missing (every row closes but the sum does not), read the page with extract_text and add it
  with fix_rows inserts.
- If read_invoice says the table was not found, try one knob from list_knobs that matches the symptom
  (read_invoice with tuning), never several at once.
- For the full result use get_invoice_json; to save it use export_invoice. Do not copy rows yourself.
- Hebrew text is already in reading order; do not reverse it.`;

const FILE = { type: "string", description: "the PDF, as the host names it (a path under the server's root, or an id)" };
const TUNING = {
  type: "string",
  description: 'layout knobs "name=value,name=value" (see list_knobs); only to fix a symptom, one knob at a time',
};
const FIX = {
  type: "object",
  additionalProperties: false,
  required: ["row", "quantity", "unit_price", "discount_pct", "line_total", "why"],
  properties: {
    row: { type: "integer", description: "the `row` from the CSV" },
    quantity: { type: "number" },
    unit_price: { type: "number", description: "price per unit before the line discount" },
    discount_pct: { type: "number", description: "0 if none" },
    line_total: { type: "number" },
    why: { type: "string", description: "what was misread, one sentence" },
  },
};
const INSERT = {
  type: "object",
  additionalProperties: false,
  required: ["after_row", "line_no", "delivery_note", "sku", "description", "quantity", "unit", "unit_price", "discount_pct", "line_total"],
  properties: {
    after_row: { type: "integer", description: "the row it follows (0 = first)" },
    line_no: { type: "integer", description: "printed line number, 0 if none" },
    delivery_note: { type: "string" },
    sku: { type: "string" },
    description: { type: "string" },
    quantity: { type: "number" },
    unit: { type: "string" },
    unit_price: { type: "number" },
    discount_pct: { type: "number" },
    line_total: { type: "number" },
  },
};

/** The tool definitions, Anthropic format ({ name, description, input_schema }). */
export function invoiceToolDefinitions({ withExport = true } = {}) {
  const tools = [
    {
      name: "read_invoice",
      description:
        "Read an invoice PDF and check its arithmetic (every row, the sum, discount, VAT, total). Returns the verdict " +
        "(ok / repairable / unreadable), the invoice facts, the totals and checks, and the failing rows as CSV. " +
        "Rows that ran together are first fixed automatically from other readings. Reading again resets earlier fixes.",
      input_schema: { type: "object", additionalProperties: false, required: ["file"], properties: { file: FILE, tuning: TUNING } },
    },
    {
      name: "get_rows",
      description: 'Rows of the item table as it stands now (with fixes): "failed", "all", or numbers like "5-12,20". CSV by default.',
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["file"],
        properties: {
          file: FILE,
          rows: { type: "string", description: '"failed" (default), "all", or "5-12,20"' },
          format: { enum: ["csv", "json"] },
        },
      },
    },
    {
      name: "fix_rows",
      description:
        "Correct misread rows (and, when a row is missing, add it). Each correction is kept only if the row's " +
        "quantity x price (less discount) then equals its total; an added row only if the sum then closes. " +
        "Returns what was kept, what was rejected and why, and the new verdict.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["file", "fixes"],
        properties: { file: FILE, fixes: { type: "array", items: FIX }, inserts: { type: "array", items: INSERT } },
      },
    },
    {
      name: "extract_text",
      description: "The PDF as Markdown (tables as Markdown tables), for reading a page around a failing row or a missing one.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["file"],
        properties: { file: FILE, pages: { type: "array", items: { type: "integer" } }, tuning: TUNING },
      },
    },
    {
      name: "get_invoice_json",
      description: "The whole invoice as one JSON document (schema pdf-inspector-he/invoice-document@1), with every line.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["file"],
        properties: { file: FILE, markdown: { type: "boolean", description: "include the extracted Markdown" } },
      },
    },
    {
      name: "list_knobs",
      description: "The layout knobs read_invoice accepts in `tuning`, with what each changes and which way to turn it.",
      input_schema: { type: "object", additionalProperties: false, properties: {} },
    },
  ];
  if (withExport) {
    tools.push({
      name: "export_invoice",
      description: "Save the invoice as it stands (with fixes): json = the full document, csv = one line per row (Excel-ready).",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["file", "format", "out"],
        properties: { file: FILE, format: { enum: ["json", "csv"] }, out: { type: "string", description: "where to write it" } },
      },
    });
  }
  return tools;
}

/** The same definitions in MCP form ({ name, description, inputSchema }). */
export function toMcpTools(tools) {
  return tools.map(({ name, description, input_schema }) => ({ name, description, inputSchema: input_schema }));
}

/** "failed" | "all" | "5-12,20" -> 0-based row indexes. */
export function parseRows(spec, count, failed) {
  const s = String(spec ?? "failed").trim();
  if (s === "failed") return failed;
  if (s === "all") return Array.from({ length: count }, (_, i) => i);
  const out = new Set();
  for (const part of s.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`rows: "${part}" is not a number or a range`);
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    for (let r = Math.max(1, from); r <= Math.min(count, to); r++) out.add(r - 1);
  }
  return [...out].sort((a, b) => a - b);
}

const MAX_TEXT = 60000;

/**
 * @param {{
 *   engine: { processPdf: Function, extractTextWithPositions: Function, listKnobs?: Function },
 *   readFile: (file: string) => Uint8Array | Promise<Uint8Array>,
 *   writeFile?: (out: string, text: string) => string | void | Promise<string | void>,
 *   context?: string,
 * }} options  writeFile returns where it wrote (shown to the model); without it export_invoice is not offered.
 */
export function createInvoiceAgent({ engine, readFile, writeFile, context = "Hebrew supplier invoice" }) {
  const sessions = new Map();
  const tools = invoiceToolDefinitions({ withExport: Boolean(writeFile) });

  async function bytesOf(file) {
    if (typeof file !== "string" || !file) throw new Error("file is required");
    return readFile(file);
  }

  async function read(file, tuning) {
    const bytes = await bytesOf(file);
    const result = readInvoice(engine, bytes, { tuning: tuning || "" });
    const session = { bytes, tuning: tuning || "", read: result, invoice: result.invoice, assessment: result.assessment };
    sessions.set(file, session);
    return session;
  }
  const session = async (file) => sessions.get(file) ?? read(file, "");

  function summary(s) {
    const doc = invoiceDocument({ ...s.read, invoice: s.invoice, assessment: s.assessment }, { repairRequest: false });
    const rows = s.invoice?.lines?.rows ?? [];
    const failing = new Set();
    for (const i of s.assessment.failedRows) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < rows.length) failing.add(j);
    const out = {
      status: doc.status,
      reasons: doc.reasons,
      pdf: doc.pdf,
      invoice: doc.invoice,
      totals: doc.totals,
      checks: doc.checks,
      columns: doc.columns.map((c) => c.role ?? c.name),
      row_count: doc.lines.length,
      failed_rows: doc.failed_rows,
      auto_fixed: doc.auto_fixed,
      repaired: doc.repaired,
    };
    if (failing.size) out.failing_rows_csv = slimCsv(s.invoice, [...failing].sort((a, b) => a - b));
    if (s.assessment.needsPages) out.needs_pages = s.assessment.pages;
    out.next =
      doc.status === "ok"
        ? "Every row and total closes."
        : doc.status === "repairable"
          ? s.assessment.needsPages
            ? "A row is missing or extra: read the pages with extract_text and add it with fix_rows inserts."
            : "Correct the failing rows with fix_rows (see failing_rows_csv)."
          : "Not readable as an invoice table: try one knob (list_knobs) with read_invoice, or extract_text.";
    return out;
  }

  const handlers = {
    async read_invoice({ file, tuning }) {
      return summary(await read(file, tuning));
    },
    async get_rows({ file, rows, format = "csv" }) {
      const s = await session(file);
      if (!s.invoice?.lines) return { rows: [], note: "no item table" };
      const indexes = parseRows(rows, s.invoice.lines.rows.length, s.assessment.failedRows);
      if (format === "json") {
        const doc = invoiceDocument({ ...s.read, invoice: s.invoice, assessment: s.assessment }, { repairRequest: false });
        return { rows: indexes.map((i) => doc.lines[i]) };
      }
      return { csv: slimCsv(s.invoice, indexes) };
    },
    async fix_rows({ file, fixes = [], inserts = [] }) {
      const s = await session(file);
      if (!s.invoice?.lines) throw new Error("no item table to fix; read_invoice first");
      const all = s.invoice.lines.rows.map((_, i) => i);
      const out = applyRepair(s.invoice, { fixes, inserts, unreadable: [], notes: "" }, { rows: all, needsPages: s.assessment.needsPages });
      s.invoice = out.invoice;
      s.assessment = assess(out.invoice);
      return { status: out.status, reasons: out.reasons, applied: out.applied, rejected: out.rejected, ...pick(summary(s), ["failed_rows", "checks", "failing_rows_csv", "next"]) };
    },
    async extract_text({ file, pages, tuning }) {
      const bytes = await bytesOf(file);
      const r = engine.processPdf(bytes, { includePageMarkers: true, pages, tuning: tuning || undefined });
      const markdown = r.markdown ?? "";
      return markdown.length > MAX_TEXT
        ? { pdf_type: r.pdfType, markdown: markdown.slice(0, MAX_TEXT), truncated: `${markdown.length - MAX_TEXT} more characters; ask for fewer pages` }
        : { pdf_type: r.pdfType, markdown };
    },
    async get_invoice_json({ file, markdown }) {
      const s = await session(file);
      const md = markdown ? engine.processPdf(s.bytes, { includePageMarkers: true, tuning: s.tuning || undefined }).markdown : undefined;
      return invoiceDocument({ ...s.read, invoice: s.invoice, assessment: s.assessment }, { markdown: md, context });
    },
    async list_knobs() {
      return { knobs: engine.listKnobs ? engine.listKnobs() : [] };
    },
    async export_invoice({ file, format, out }) {
      if (!writeFile) throw new Error("export is not available here");
      const s = await session(file);
      const doc = invoiceDocument({ ...s.read, invoice: s.invoice, assessment: s.assessment }, { repairRequest: false });
      const text = format === "csv" ? toCsv(s.invoice ? toRecords(s.invoice) : []) : JSON.stringify(doc, null, 2) + "\n";
      const where = (await writeFile(out, text)) || out;
      return { written: where, format, lines: doc.lines.length, status: doc.status, checks_ok: doc.invoice?.checks_ok ?? false };
    },
  };

  /** Run one tool. Never throws: errors come back as { ok: false, result: { error } } for the model to read. */
  async function call(name, input = {}) {
    const handler = handlers[name];
    if (!handler || (name === "export_invoice" && !writeFile)) return { ok: false, result: { error: `unknown tool: ${name}` } };
    try {
      return { ok: true, result: await handler(input ?? {}) };
    } catch (e) {
      return { ok: false, result: { error: String(e?.message ?? e) } };
    }
  }

  return { tools, mcpTools: toMcpTools(tools), instructions: INVOICE_AGENT_INSTRUCTIONS, call };
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/** A tool result as the text a model reads: CSV as is, everything else as compact JSON. */
export function resultText(result) {
  if (result && typeof result === "object" && typeof result.csv === "string" && Object.keys(result).length === 1) return result.csv;
  return JSON.stringify(result);
}
