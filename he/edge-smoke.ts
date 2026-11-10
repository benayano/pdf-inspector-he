// The Edge package the way a Supabase function uses it:
//   deno run --allow-read he/edge-smoke.ts <edge dir> <invoice.pdf>...
// load() from the embedded wasm, readInvoice() on each invoice (every check
// must pass), and a repair request for a damaged row stays small.
import { toFileUrl, resolve } from "jsr:@std/path@1";

const [dir, ...pdfs] = Deno.args;
const mod = (f: string) => import(toFileUrl(resolve(dir, f)).href);
const { load } = await mod("edge.mjs");
const { readInvoice, repairRequest, applyRepair } = await mod("repair.mjs");
const { recheck } = await mod("invoice.mjs");

const t0 = performance.now();
const pdf = await load();
console.log(`load: ${Math.round(performance.now() - t0)} ms, version ${pdf.version()}`);

for (const path of pdfs) {
  const bytes = await Deno.readFile(path);
  const t = performance.now();
  const read = readInvoice(pdf, bytes);
  const ms = Math.round(performance.now() - t);
  if (read.assessment.status !== "ok") throw new Error(`${path}: ${JSON.stringify(read.assessment.reasons)}`);
  const rows = read.invoice.lines.rows;
  // Damage one row as a misread would, and repair it from the request.
  const i = Math.floor(rows.length / 2);
  const damaged = rows.map((r: { values: Record<string, number> }, k: number) =>
    k === i ? { ...r, values: { ...r.values, total: r.values.total + 9 } } : r
  );
  const broken = recheck({ ...read.invoice, lines: { ...read.invoice.lines, rows: damaged } });
  const req = repairRequest(broken);
  const v = rows[i].values;
  const fixed = applyRepair(broken, {
    fixes: [{ row: i + 1, quantity: v.quantity, unit_price: v.unitPrice ?? v.netUnitPrice, discount_pct: v.discount ?? 0, line_total: v.total, why: "" }],
    inserts: [], unreadable: [], notes: "",
  }, req);
  if (fixed.status !== "ok") throw new Error(`${path}: repair did not close: ${JSON.stringify(fixed.rejected)}`);
  console.log(`ok: ${path.split("/").pop()} ${rows.length} rows in ${ms} ms; repair request ${req.prompt.length} chars`);
}

// The agent tools on the Edge package, as an in-process agent would use them.
const { createInvoiceAgent } = await mod("agent.mjs");
const files = new Map(pdfs.map((p) => [p.split("/").pop(), p]));
const agent = createInvoiceAgent({ engine: pdf, readFile: (f: string) => Deno.readFile(files.get(f) ?? f) });
const first = [...files.keys()][0];
const read = await agent.call("read_invoice", { file: first });
if (!read.ok || read.result.status !== "ok") throw new Error(`agent read_invoice: ${JSON.stringify(read.result)}`);
const doc = await agent.call("get_invoice_json", { file: first });
if (doc.result.schema !== "pdf-inspector-he/invoice-document@1") throw new Error("agent get_invoice_json");
console.log(`ok: agent tools (${agent.tools.length}) on ${first}`);
