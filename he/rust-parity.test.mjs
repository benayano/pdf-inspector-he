// readInvoice() in Rust (the engine's invoiceCall, src/invoice/) against the
// JS original (`js: true`) on the corpus: the same invoice, assessment and
// automatic fixes. Through the native binary; skipped when it is not built.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cliEngine, defaultBinary } from "./engines.mjs";
import { applyRepair, readInvoice, repairRequest } from "./repair.mjs";
import { invoiceDocument } from "./document.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const skip = !defaultBinary();
const PDFS = [
  "./fixtures/invoices/print-to-pdf-5p.pdf",
  "./fixtures/invoices/priority-1p.pdf",
  "./fixtures/invoices/priority-2p.pdf",
  "./fixtures/invoices/priority-4p.pdf",
  "./fixtures/repair/priority-1p.misread-row11.pdf",
].map(here);

/**
 * JSON without the cell parse's intermediate `amounts` and without `details`
 * (read only by the Rust layer; held by tests/invoice_golden.rs), numbers as JSON prints them.
 */
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "amounts" || k === "details" ? undefined : x)));

test("Rust and JS read the corpus the same way", { skip }, () => {
  const engine = cliEngine();
  try {
    assert.equal(typeof engine.invoiceCall, "function");
    for (const pdf of PDFS) {
      const bytes = new Uint8Array(readFileSync(pdf));
      const rust = readInvoice(engine, bytes);
      const js = readInvoice(engine, bytes, { js: true });
      assert.equal(rust.pdfType, js.pdfType, pdf);
      assert.deepEqual(plain(rust.assessment), plain(js.assessment), pdf);
      assert.deepEqual(rust.autoFixed, js.autoFixed, pdf);
      assert.deepEqual(plain(rust.invoice), plain(js.invoice), pdf);
      assert.deepEqual(plain(invoiceDocument(rust)), plain(invoiceDocument(js)), pdf);
    }
  } finally {
    engine.close();
  }
});

test("a Rust read is repaired by the JS applyRepair (same data model)", { skip }, () => {
  const engine = cliEngine();
  try {
    const read = readInvoice(engine, new Uint8Array(readFileSync(PDFS[4])));
    const req = repairRequest(read.invoice);
    const out = applyRepair(read.invoice, { fixes: [{ row: 11, quantity: 1, unit_price: 27.35, discount_pct: 0, line_total: 27.35, why: "digit" }] }, req);
    assert.equal(out.status, "ok");
  } finally {
    engine.close();
  }
});
