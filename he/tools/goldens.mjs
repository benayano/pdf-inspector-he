// Records what the JS invoice layer produces on the corpus, as the oracle
// the Rust port (src/invoice/) is held to:
//
//   node he/tools/goldens.mjs          # rewrite he/fixtures/golden/*.json
//
// For each PDF: parseInvoice() (everything but the raw `amounts`), the JSON
// document of readInvoice(), toCsv(toRecords()) and, when repairable, the
// repair request. Run only after an intended change to the JS layer, and
// read the diff — the Rust tests compare against these files.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEngine } from "../engines.mjs";
import { parseInvoice, toCsv, toRecords } from "../invoice.mjs";
import { readInvoice, repairRequest } from "../repair.mjs";
import { invoiceDocument } from "../document.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PDFS = [
  "../fixtures/invoices/print-to-pdf-5p.pdf",
  "../fixtures/invoices/priority-1p.pdf",
  "../fixtures/invoices/priority-2p.pdf",
  "../fixtures/invoices/priority-4p.pdf",
  "../fixtures/repair/priority-1p.misread-row11.pdf",
].map(here);

const engine = cliEngine();
try {
  for (const path of PDFS) {
    const bytes = new Uint8Array(readFileSync(path));
    const markdown = engine.processPdf(bytes, { includePageMarkers: true }).markdown;
    const items = engine.extractTextWithPositions(bytes);
    const parsed = parseInvoice({ markdown, items });
    // `amounts` are an intermediate of the cell parse; `values` carry the result.
    const invoice = { ...parsed, lines: parsed.lines && { ...parsed.lines, rows: parsed.lines.rows.map(({ amounts, ...r }) => r) } };
    const read = readInvoice(engine, bytes);
    const out = {
      invoice,
      document: invoiceDocument(read),
      csv: toCsv(toRecords(read.invoice), { bom: false, excelSafe: false }),
      repair: read.assessment.status === "repairable" ? repairRequest(read.invoice) : null,
    };
    const name = basename(path, ".pdf");
    writeFileSync(here(`../fixtures/golden/${name}.json`), JSON.stringify(out, null, 1) + "\n");
    console.log(`golden: ${name} (${out.document.status}, ${out.document.lines.length} lines)`);
  }
} finally {
  engine.close();
}
