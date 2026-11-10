#!/usr/bin/env node
// The invoice from the command line, as JSON (or CSV), through the same tools
// the agent and the MCP server use:
//
//   node he/cli.mjs invoice.pdf                      # full JSON document (invoice-document@1)
//   node he/cli.mjs invoice.pdf --format summary     # verdict, totals, checks, failing rows (what read_invoice returns)
//   node he/cli.mjs invoice.pdf --format csv         # one line per row (Excel-ready)
//   node he/cli.mjs invoice.pdf --format repair      # the compact repair request (prompt + schema), if any
//   node he/cli.mjs invoice.pdf --tune number_gap=auto --engine wasm:<edge dir> --markdown --out result.json
//
// Exit code: 0 ok, 2 repairable, 3 unreadable, 1 error — so a script can branch on it.
import { readFileSync, writeFileSync } from "node:fs";
import { createInvoiceAgent, resultText } from "./agent.mjs";
import { engineFromSpec } from "./engines.mjs";
import { toCsv } from "./invoice.mjs";

const USAGE = "usage: node he/cli.mjs <invoice.pdf> [--format json|summary|csv|repair] [--tune K=V,...] [--engine cli|cli:<path>|wasm:<dir>] [--markdown] [--out FILE]";

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(format|tune|engine|out)$/));
  if (!file || args.includes("--help")) {
    console.error(USAGE);
    return 1;
  }
  const format = option(args, "--format") ?? "json";
  const engine = await engineFromSpec(option(args, "--engine"));
  try {
    const agent = createInvoiceAgent({ engine, readFile: (f) => new Uint8Array(readFileSync(f)) });
    const read = await agent.call("read_invoice", { file, tuning: option(args, "--tune") });
    if (!read.ok) throw new Error(read.result.error);
    let text;
    if (format === "summary") text = JSON.stringify(read.result, null, 2);
    else {
      const doc = await agent.call("get_invoice_json", { file, markdown: args.includes("--markdown") });
      if (!doc.ok) throw new Error(doc.result.error);
      if (format === "json") text = JSON.stringify(doc.result, null, 2);
      else if (format === "repair") text = JSON.stringify(doc.result.repair, null, 2);
      else if (format === "csv") {
        // The document's lines (with fixes) plus the invoice's own columns, as toCsv lays them out.
        text = resultText({ csv: toCsv(docRecords(doc.result)) });
      } else throw new Error(`--format ${format}: expected json, summary, csv or repair`);
    }
    const out = option(args, "--out");
    if (out) writeFileSync(out, text.endsWith("\n") ? text : text + "\n");
    else process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    return { ok: 0, repairable: 2, unreadable: 3 }[read.result.status] ?? 1;
  } finally {
    engine.close?.();
  }
}

/** The document's lines with the invoice facts on each, in toRecords' column order. */
function docRecords(doc) {
  const inv = doc.invoice ?? {};
  return doc.lines.map((l) => ({
    invoice_number: inv.invoice_number ?? null,
    invoice_date: inv.invoice_date ?? null,
    supplier_name: inv.supplier_name ?? null,
    supplier_tax_id: inv.supplier_tax_id ?? null,
    ...l,
  }));
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  },
);
