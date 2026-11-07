#!/usr/bin/env node
// Regression run over the anonymized invoice corpus (he/fixtures/invoices).
//
//   node he/regression.mjs [path/to/pdf2md] [--update] [--tune k=v,...]
//
// For every PDF: the item table must have the expected number of rows
// (numbered 1..N, none missing) and one column count on every row; and the
// whole Markdown must equal `<name>.expected.md`. `--update` rewrites the
// expected files after an intended change — review that diff before
// committing it. The invoice layer (he/invoice.mjs) then reads the same PDF:
// every line, discount, VAT and total check must hold, and the header
// fields listed in expectations.json must come out. Exit code 1 on any
// failure.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseInvoice } from "./invoice.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "fixtures", "invoices");
const args = process.argv.slice(2);
const update = args.includes("--update");
const tuneAt = args.indexOf("--tune");
const tune = tuneAt >= 0 ? ["--tune", args[tuneAt + 1]] : [];
const bin =
  args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--tune") ??
  path.join(here, "..", "target", "release", "pdf2md");
const expectations = JSON.parse(fs.readFileSync(path.join(dir, "expectations.json"), "utf8"));

export function itemRows(markdown) {
  return markdown
    .split("\n")
    .filter((l) => /^\|\d+\|/.test(l))
    .map((l) => ({ n: Number(l.split("|")[1]), columns: l.split("|").length - 2 }));
}

let failures = 0;
for (const [file, expect] of Object.entries(expectations)) {
  const pdf = path.join(dir, file);
  const markdown = execFileSync(bin, ["--raw", "--pages", ...tune, pdf], { encoding: "utf8" });
  const rows = itemRows(markdown);
  const problems = [];
  const numbers = new Set(rows.map((r) => r.n));
  const missing = [];
  for (let n = 1; n <= expect.itemRows; n++) if (!numbers.has(n)) missing.push(n);
  if (rows.length !== expect.itemRows) problems.push(`item rows ${rows.length}, expected ${expect.itemRows}`);
  if (missing.length) problems.push(`missing rows ${missing.slice(0, 10).join(",")}`);
  const columnCounts = [...new Set(rows.map((r) => r.columns))];
  if (columnCounts.length !== 1 || columnCounts[0] !== expect.columns) {
    problems.push(`column counts ${columnCounts.join(",")}, expected ${expect.columns}`);
  }
  const expectedPath = pdf.replace(/\.pdf$/, ".expected.md");
  if (update) {
    fs.writeFileSync(expectedPath, markdown);
  } else if (!fs.existsSync(expectedPath)) {
    problems.push("no expected output (run with --update)");
  } else {
    const want = fs.readFileSync(expectedPath, "utf8").split("\n");
    const got = markdown.split("\n");
    const changed = [];
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      if (want[i] !== got[i]) changed.push(i + 1);
    }
    if (changed.length) {
      const i = changed[0] - 1;
      problems.push(
        `output differs on ${changed.length} line(s); first at line ${changed[0]}:\n` +
          `      expected: ${(want[i] ?? "").slice(0, 160)}\n` +
          `      got:      ${(got[i] ?? "").slice(0, 160)}`,
      );
    }
  }
  // The invoice layer: every arithmetic check it can run must hold, and the
  // ones this invoice is known to support must run.
  const items = JSON.parse(execFileSync(bin, ["--items-json", ...tune, pdf], { encoding: "utf8" }));
  const invoice = parseInvoice({ markdown, items });
  if (invoice.lines?.rows.length !== expect.itemRows) {
    problems.push(`invoice layer: ${invoice.lines?.rows.length ?? 0} lines, expected ${expect.itemRows}`);
  }
  for (const c of invoice.checks.filter((c) => !c.ok)) {
    problems.push(`invoice check ${c.name} failed: ${JSON.stringify(c).slice(0, 200)}`);
  }
  const ran = new Set(invoice.checks.map((c) => c.name));
  const absent = (expect.checks ?? []).filter((name) => !ran.has(name));
  if (absent.length) problems.push(`invoice checks did not run: ${absent.join(", ")}`);
  for (const [label, value] of Object.entries(expect.fields ?? {})) {
    const got = invoice.header.fields.find((f) => f.label === label)?.value;
    if (got !== value) problems.push(`header field ${label}: ${got ?? "missing"}, expected ${value}`);
  }
  if (problems.length) {
    failures++;
    console.log(`FAIL ${file}\n  - ${problems.join("\n  - ")}`);
  } else {
    console.log(`ok   ${file} (${rows.length} rows x ${columnCounts[0]} columns, ${ran.size} checks)`);
  }
}
if (update) console.log("expected outputs updated — review the diff before committing");
process.exit(failures ? 1 : 0);
