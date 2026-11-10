# pdf-inspector-he — guide for LLM agents

> Development rules for this repository are in the root `CLAUDE.md`. This
> file is about **using** the library from an agent.

This file is for an agent (or the developer wiring one up) that uses
pdf-inspector-he to read PDFs, especially Hebrew / right-to-left invoices.
It covers what the tool does, every entry point and parameter, how to
expose it as tools, and how to run an optional partial LLM review.

Hebrew background on each fix: `he/README.md`. Build/test rules for the
Rust crate: the root `CLAUDE.md`.

---

## 1. What it does

| Capability | Where | Notes |
|---|---|---|
| PDF type detection (TextBased / Scanned / Mixed / ImageBased) | all bindings | Scanned pages are reported, not extracted (OCR is a separate feature) |
| PDF → Markdown (headings, paragraphs, lists, tables) | all bindings | Tables come out as Markdown tables, RTL tables rightmost column first |
| Positioned text items (text, page, x, y, width, height, font, bold, rotation) | all bindings | PDF points, origin bottom-left, y grows upward |
| Hebrew / RTL lines drawn one glyph at a time | core | Word gaps and number order fixed (`1.2 3` no longer becomes `31.2`) |
| Bordered tables drawn as thin filled strips, cell by cell | core | Browser / Print-To-PDF and Winnovative (Priority ERP) invoices |
| Vertical margin stamps drawn glyph by glyph | core | Joined into one run, emitted as its own line after the page body |
| Tunable layout knobs ("auto" by default) | all bindings | Section 3 |
| Partial LLM review of ambiguous rows / competing outputs | `he/rtl-check.mjs` | Section 5 |
| Invoice layer: lines, header blocks, fields, totals, arithmetic checks | `he/invoice.mjs` | Section 4 |
| Flat records and CSV (Excel / SQL `COPY` / `insert`) | `he/invoice.mjs` | Section 4.2 |

What it does **not** do: OCR in the default build, read scanned invoices,
or guess silently. A check that cannot run is absent; one that fails says
by how much.

---

## 2. Entry points

### CLI (`pdf2md`)

```bash
pdf2md file.pdf                    # Markdown with a short header
pdf2md --raw --pages file.pdf      # Markdown only, with <!-- Page N --> markers  ← use this for the invoice layer
pdf2md --json file.pdf             # result object as JSON
pdf2md --items-json file.pdf       # positioned items ({ items: [...] })          ← and this
pdf2md --select-pages 1,3-5 file.pdf
pdf2md --tune rule_join_gap=3,short_rule_ratio=auto file.pdf
pdf2md --number-gap auto file.pdf  # same as --tune number_gap=auto
pdf2md --list-knobs                # every knob with its unit, auto value and effect
detect-pdf --analyze --json file.pdf
```

Env equivalents: `PDF_INSPECTOR_TUNING="k=v,k=v"`, `PDF_INSPECTOR_NUMBER_GAP_EM`.

### WASM (browser, Deno, Supabase Edge Functions)

Built by CI (`.github/workflows/he-build.yml`) as artifacts
`pdf-inspector-he-wasm-web` and `pdf-inspector-he-wasm-deno`; a tag `he-v*`
makes a release. Both packages also contain `rtl-check.mjs` and
`invoice.mjs` with their `.d.ts`.

```ts
import * as pdf from "./pdf-inspector/pdf_inspector.js";

const result = pdf.processPdf(bytes, {
  includePageMarkers: true,   // needed by the invoice layer
  pages: [1, 2],              // optional, 1-indexed
  profile: "fidelity",        // or "compact" (fewer tokens)
  numberGap: 0.2,             // or "auto"
  tuning: "rule_join_gap=3",  // knob string, section 3
  password: "…",
});
// result.pdfType, result.markdown, result.pagesNeedingOcr, result.layout, result.producer, …

const items = pdf.extractTextWithPositions(bytes, { pages, numberGap, tuning });
// [{ text, page, x, y, width, height, fontSize, font, isBold, isItalic, rotation }]

pdf.listKnobs();   // [{ name, unit, auto, effect }]
pdf.classifyPdf(bytes); pdf.detectPdf(bytes); pdf.extractText(bytes); pdf.version();
```

Full Supabase example: `he/supabase-example/index.ts`.

### Node native (`napi/`)

`processPdf(buffer, pages?)`, `extractTextWithPositions(...)` and the rest of
the upstream API, plus process-wide settings: `setTuning(str | null)`,
`getTuning()`, `setNumberGap(number | "auto" | null)`, `getNumberGap()`,
`listKnobs()`.

### Python

```python
import pdf_inspector as pi
r = pi.process_pdf("file.pdf", pages=None, number_gap=None, tuning="rule_join_gap=3")
items = pi.extract_text_with_positions("file.pdf", tuning="number_gap=auto")
pi.set_tuning("short_rule_ratio=0.2"); pi.get_tuning(); pi.list_knobs()
pi.set_number_gap("auto"); pi.get_number_gap()
```

### Rust

`pdf_inspector::with_tuning(tuning, || process_pdf(...))` for one call,
`set_process_tuning` for the process; `Tuning::parse("k=v,…")`,
`KNOBS` for the descriptions.

The invoice layer itself is Rust (`pdf_inspector::invoice`): `read::read_invoice(bytes, tuning,
alternatives, pages)` → `document::invoice_document(&read, &options)` (the JSON document), and
`repair::{assess, repair_request, apply_repair}`. One JSON call for bindings:
`invoice::api::call(method, request_json, bytes)` — `read_invoice` returns `{document, state, …}`,
`apply_repair` takes `{state, answer}` back. The JS modules in `he/` run the same read through it
(`readInvoice` uses the engine's `invoiceCall` when present).

`read_invoice` reads the document **once** (the Markdown and the positioned items come from the same
pass) after classifying it, so a scan costs a millisecond or two. Request options beyond `tuning` /
`alternatives` / `pages`: `max_pages` (a longer document is answered `unreadable`, unread) and
`first_page` (page 1's Markdown in the reply, no second extraction). The reply also carries
`page_count`, `engine` (the version), `tuning` and `read_ms` (null in wasm: no clock).

`document.details` (and `invoice.details` in `state`) is what whoever pays the invoice needs, read
from the labelled fields around the table and the text under it (`src/invoice/details.rs`):
`due_date` (ISO, only a printed date), `payment_terms`, `supplier_phone`, `supplier_address`,
`bank_code` / `bank_branch` / `bank_account` (all three or none, only after "להעברה" / "פרטי בנק"),
`allocation_number`. A value that is not printed is null.

### Apps: C ABI and Dart (`dart:ffi`)

`ffi/` builds `libpdf_inspector_he` (header `ffi/include/pdf_inspector_he.h`): `pdfhe_call(method,
request, bytes, len)` → JSON, `pdfhe_free`, `pdfhe_abi_version`. `dart/pdf_inspector_he` wraps it:
`PdfInspectorHe.open().readInvoice(bytes)` → typed `InvoiceDocument` + opaque `InvoiceState`;
`applyRepair(state, answer)`; `readInvoiceAsync` runs in an isolate. Nothing calls a model.

---

## 3. Knobs

Every knob defaults to **auto**, which is what the regression corpus is
tuned on. Set a knob only when the output shows the symptom in the table,
and only for that document. Format: `"name=value,name=value"`, value a
number or `auto`; unlisted knobs stay auto. Unknown names are an error.
Precedence: per-call (`with_tuning` / `tuning` option) → process
(`setTuning`) → env → auto.

| Knob | Unit | Auto | Symptom → turn which way |
|---|---|---|---|
| `number_gap` | em | 0.2 (glyph-per-item lines: the line's own word gap) | Two numbers read as one (`31.2` for `1.2 3`) → lower. A number split at its decimal point → raise |
| `word_gap_cap` | em | 1.0 | Words of widely spaced text glued → raise. Table row words glued together → lower |
| `rule_thickness` | pt | 3.0 | Thick drawn borders not seen as table lines → raise. `0` disables reading fills as rules |
| `rule_join_gap` | pt | 2.0 | A bordered table not found as a table (grid drawn in pieces) → raise (3–4) |
| `short_rule_ratio` | fraction | 0.3 | A real column lost → lower. Phantom empty columns (from a totals box under the table) → raise |
| `stacked_line_gap` | em | 0.5 | Two-line header cell letters interleaved → lower. Superscripts split off → raise |
| `latin_digit_split` | 0/1 | 1 only on an RTL line no Unicode-bidi reading reproduces (word-by-word layout: Priority / Winnovative), else 0 | Numbers jump in front of a Latin product name (`3000 "1.5 HIGH TECH`) → 1. A Latin phrase loses its trailing number → 0 |

`pdf2md --list-knobs` / `listKnobs()` returns the same text; feed it to the
model rather than hard-coding this table.

**Rule for agents:** never set several knobs at once on a first try. Change
one, compare outputs (or let `chooseTuning` compare), keep the change only if
the target symptom is fixed and nothing else got worse.

---

## 4. Invoice layer (`he/invoice.mjs`)

```js
import { parseInvoice } from "./invoice.mjs";
const invoice = parseInvoice({
  markdown,           // processPdf(..., { includePageMarkers: true }).markdown, or pdf2md --raw --pages
  items,              // extractTextWithPositions(bytes), or pdf2md --items-json (object or array)
});
```

Returns (types in `he/invoice.d.ts`):

| Field | Content |
|---|---|
| `rtl` | Document reads right to left |
| `lines.columns` | `{ name, role }`; roles: `index`, `description`, `sku`, `date`, `quantity`, `unitPrice`, `netUnitPrice`, `discount`, `total` |
| `lines.rows[]` | `cells` (raw strings), `amounts` (parsed per cell), `values` (by role, numbers normalized, `unit` from the quantity cell), `check` (row arithmetic), `page` |
| `lines.pages` | Pages the merged table spans |
| `header.blocks[]` | Blocks above the table, each separate (customer block vs. dates block): `lines`, `text`, `fields`, `page`, `left/right/top` |
| `header.fields[]` | `{ label, value }` — "תאריך חשבונית", "מספר תעודה", "עוסק מורשה", "Email", … |
| `totals[]` | `{ label, value, role, percent, currency }`; roles `subtotal`, `discount`, `afterDiscount`, `vat`, `total`, `balance` |
| `footer.fields` | Every label/value pair found in the totals zone (including ones with no role) |
| `checks[]` | Section 4.1 |

Helpers also exported: `invoiceInfo`, `toRecords`, `toCsv`, `isoDate` (section 4.2), `parseAmount` (`"461.54-"`, `"101.69 ש"ח"`, `"60.80 מטר"`, `"(0.04%-)"`), `splitField`,
`markdownTables`, `mergeTables`, `lineItems`, `headerBlocks`.

Without `items` you still get `lines` and row checks, but no header blocks,
no totals and no totals checks.

### 4.1 Checks

| Name | Meaning |
|---|---|
| `line-arithmetic` | Each row: quantity × unit price × (1 − discount%) = line total, or quantity × net price. Tolerance covers prices and quantities rounded to cents. `failed[]` lists the rows |
| `lines-sum` | Sum of row totals = subtotal ("מחיר כולל") |
| `discount` | Subtotal ± discount = after-discount; `sign` tells which (printed signs are unreliable) |
| `vat` | After-discount × VAT rate (from the label, e.g. "מע"מ (18.00%)") = VAT |
| `grand-total` | After-discount + VAT = total |

**How an agent should use them:**

- All present and `ok` → trust the numbers; no LLM review needed.
- `line-arithmetic` fails on a few rows → those rows may be misread. Re-extract
  with `number_gap=auto` or run the partial review (section 5) on those rows
  only; if they still fail, report them to the user with `expected`/`diff`.
  A real pricing error on the supplier's side looks exactly the same: say so,
  do not "fix" the number.
- `lines-sum` fails but every row passes → a row is missing or extra (page
  break, totals table merged into lines). Compare `lines.rows.length` and the
  index column for gaps.
- A check is **absent** → the layer could not find that total; don't claim it
  passed.

On the four corpus invoices (344 rows, Print-To-PDF and Priority/Winnovative)
all five checks pass; `he/regression.mjs` enforces that.

### 4.2 Records, CSV, database

```js
import { parseInvoice, invoiceInfo, toRecords, toCsv, RECORD_COLUMNS } from "./invoice.mjs";
const invoice = parseInvoice({ markdown, items });

invoiceInfo(invoice);
// { invoice_number, invoice_date (ISO), supplier_name, supplier_tax_id (digits),
//   subtotal, discount, after_discount, vat_rate, vat, total, currency, checks_ok }

const records = toRecords(invoice);   // one flat object per line, keys = RECORD_COLUMNS:
// invoice_number, invoice_date, supplier_name, supplier_tax_id, line_no, page, date,
// delivery_note, order_ref, sku, description, quantity, unit, unit_price, discount_pct,
// net_unit_price, line_total, currency, check_ok, check_diff

toCsv(records);                                       // for Excel: BOM + formula-safe text
toCsv(records, { bom: false, excelSafe: false });     // for COPY … CSV HEADER
```

Numbers are numbers (a credit line stays negative), dates ISO, anything not
found is `null`, never guessed. `supplier_*` come from the header block that
holds the tax id ("עוסק מורשה"); the customer's ids are not used.

Into a database, without building SQL text:

```js
await supabase.from("invoice_lines").insert(records);            // Supabase
await supabase.from("invoices").insert(invoiceInfo(invoice));
```

```sql
-- Postgres: one call with the JSON array as a parameter
INSERT INTO invoice_lines SELECT * FROM jsonb_populate_recordset(NULL::invoice_lines, $1::jsonb);
-- or from the CSV
\copy invoice_lines FROM 'lines.csv' CSV HEADER
```

Map the columns to your own tables in your application; this library does
not know your schema and does not write SQL.

**Why the tool should write the file itself:** if the handler writes the CSV
or inserts the rows, the model sees only a summary ("162 lines, all checks
passed, saved to …"). Passing 162 rows through the model to have it write
them again costs tokens and invites copy errors.

---

## 5. Partial LLM review (optional) — `he/rtl-check.mjs`

Use the model only where the extractor's output depends on a parameter, not
on the whole document. You supply the model call:

```js
const ask = async (prompt) => /* call your LLM, return its text */;
```

### 5.1 Ambiguous number order (the `number_gap` knob)

```js
import { extractWithLlmCheck } from "./rtl-check.mjs";
const extract = (data, o) => pdf.extractTextWithPositions(data, o);

const result = await extractWithLlmCheck(extract, bytes, ask, {
  candidates: [0.1, 0.2, 0.3], // default
  sample: 12,                  // rows shown to the model at most
  minAgreement: 0.6,           // share of answers that must agree
  context: "Hebrew supplier invoice, building materials",
  fallbackGap: 0.2,
});
// result.numberGap, result.rows, result.check.reason:
//   "no-ambiguous-rows" (model not called), "llm-majority", "llm-undecided", "low-agreement"
```

How it works: extract with each candidate, keep only rows whose text
differs between candidates (usually none or a handful), show the model the
distinct readings as A/B/C (never the gap values), take the majority, and
re-extract the **whole document** with the winning gap. Ties prefer the
default. Lower-level pieces: `findAmbiguousRows`, `buildPrompt`, `chooseNumberGap`.

### 5.2 Competing knob settings (any knob)

```js
import { chooseTuning } from "./rtl-check.mjs";
const run = (data, { tuning }) => pdf.processPdf(data, { tuning, includePageMarkers: true }).markdown;

const pick = await chooseTuning(run, bytes, ask, {
  candidates: ["", "rule_join_gap=4", "short_rule_ratio=0.2"],
  context: "the item table should have 9 columns",
  maxLines: 25,
});
// pick.tuning (null = keep auto), pick.reason: "identical-outputs" | "llm-choice" | "llm-undecided", pick.why
```

Only the lines that differ between candidates go to the model. Identical
outputs → no model call.

### 5.3 When to run a review

1. Run with auto. Run `parseInvoice`.
2. All checks pass → done, no review.
3. Rows fail → 5.1 (numbers) on the document, then re-check.
4. Table shape is wrong (column count varies, rows missing, totals glued to
   the last row) → 5.2 with 2–3 candidates built from the symptom table in
   section 3.
5. Still failing → return the result with the failed checks, don't loop.

Cap it: at most one 5.1 and one 5.2 per document.

---

### 5.4 Repair with the model working on the result (`he/repair.mjs`)

When most of an invoice reads right and a few rows or a total do not,
re-reading the whole PDF with a model throws the right part away. Instead:

```js
import { readInvoice, repairRequest, applyRepair } from "./repair.mjs";
const read = readInvoice(pdf, bytes);          // extract + parse + autoRepair (no model)
// read.assessment.status: "ok" | "repairable" | "unreadable"; .failedRows, .failedChecks, .needsPages, .pages
if (read.assessment.status === "repairable") {
  const req = repairRequest(read.invoice, { context: "Hebrew supplier invoice" });
  // req.prompt: totals line + failed checks + ONLY the failing rows (± a neighbour) as CSV
  // req.schema: JSON schema of the answer { fixes[], inserts[], unreadable[], notes }
  // req.needsPages: a row is missing — attach req.pages (PDF pages or images)
  const fixed = applyRepair(read.invoice, await ask(req.prompt, req.schema), req);
  // a fix is kept only if its row then closes; an insert only if the sum then closes
}
```

- `autoRepair(invoice, alternatives)` runs inside `readInvoice`: a failing
  row is taken from another reading (`number_gap` 0.1 / 0.3 / auto) only
  where it closes there. Often no model is needed at all.
- Send the request **as CSV in, JSON out**: compact rows cost a few hundred
  tokens (a damaged row of a 162-row invoice: ~1.4k characters); the answer
  goes through structured output, which CSV cannot.
- `unreadable` in the answer is for rows whose printed numbers really
  disagree — a supplier error is a finding, not something to "fix".
- Short tables (≤ 25 rows) go whole; the neighbours give context for free.

## 6. Exposing it as tools

### 6.0 Ready-made: `he/agent.mjs`, the MCP server, the CLI

Everything below is implemented; the later subsections explain the design.

```js
import { createInvoiceAgent } from "./agent.mjs";
const agent = createInvoiceAgent({ engine: pdf, readFile: (f) => bytesOf(f), writeFile: (out, text) => save(out, text) });
// agent.tools (Anthropic), agent.mcpTools (MCP), agent.instructions (system prompt text)
const { ok, result } = await agent.call("read_invoice", { file: "a.pdf" });
```

| Tool | Does |
|---|---|
| `read_invoice {file, tuning?}` | read + check (+ auto-repair); verdict, facts, totals, checks, failing rows as CSV, `next` |
| `get_rows {file, rows?, format?}` | rows `failed` / `all` / `5-12,20`, CSV (default) or JSON |
| `fix_rows {file, fixes[], inserts?}` | corrections kept only when the row's arithmetic closes; inserts only when the sum closes |
| `extract_text {file, pages?, tuning?}` | Markdown of the pages, for looking at a row |
| `get_invoice_json {file, markdown?}` | the full JSON document (`invoice-document@1`, `he/invoice-document.schema.json`) |
| `list_knobs {}` | the knobs |
| `export_invoice {file, format, out}` | json / csv to a file — only when the host passes `writeFile` |

The agent IS the model that repairs: no second model is called. Session state
(the invoice as fixed so far) is per file; `read_invoice` resets it.

- **MCP**: `node he/mcp-server.mjs --root DIR [--engine cli|cli:<pdf2md>|wasm:<edge dir>] [--no-export]`,
  e.g. `claude mcp add pdf-inspector-he -- node he/mcp-server.mjs --root ~/invoices`. Files must stay inside `--root`.
- **CLI**: `node he/cli.mjs file.pdf [--format json|summary|csv|repair] [--tune …] [--out FILE]`;
  exit code 0 ok / 2 repairable / 3 unreadable / 1 error.
- **Engines** (`he/engines.mjs`, Node): `cliEngine()` (the native binary) or `wasmEngine(dir)` (the Edge package),
  one interface. In Deno / Supabase use `load()` from the Edge package directly.



Keep the tools few and give the model the knob text at runtime.

### 6.1 `extract_pdf` (generic)

`extractionToolDefinition(listKnobs())` from `rtl-check.mjs` returns a
ready Anthropic-style tool definition:

```json
{
  "name": "extract_pdf",
  "description": "Extract the PDF as Markdown. Optionally pass layout knobs when the previous output looked wrong …",
  "input_schema": {
    "type": "object",
    "properties": {
      "tuning": { "type": "string", "description": "Comma-separated knob=value pairs … Knobs:\n- number_gap (em; auto: …): …" },
      "pages":  { "type": "array", "items": { "type": "integer" } }
    }
  }
}
```

Handler: `pdf.processPdf(bytes, { tuning, pages, includePageMarkers: true })`.
Return `markdown`, `pdfType`, `pagesNeedingOcr`; if `pdfType` is `Scanned`
or `ImageBased`, return that instead of empty text.

### 6.2 `parse_invoice` (recommended for invoices)

```json
{
  "name": "parse_invoice",
  "description": "Read a supplier invoice PDF into lines, header fields and totals, with arithmetic checks. Call with no tuning first; pass tuning only to fix a failed check or a wrong table shape.",
  "input_schema": {
    "type": "object",
    "properties": {
      "tuning": { "type": "string", "description": "<same knob text as extract_pdf>" },
      "review": { "type": "string", "enum": ["none", "numbers", "auto"], "description": "numbers: run the number-order review; auto: run it only if line checks fail. Default none." }
    }
  }
}
```

Handler sketch:

```js
async function parseInvoiceTool(bytes, { tuning = "", review = "none" }, ask) {
  const run = (t) => {
    const r = pdf.processPdf(bytes, { tuning: t, includePageMarkers: true });
    if (r.pdfType !== "TextBased" && r.pdfType !== "Mixed") return { pdfType: r.pdfType };
    const items = pdf.extractTextWithPositions(bytes, { tuning: t });
    return { pdfType: r.pdfType, invoice: parseInvoice({ markdown: r.markdown, items }) };
  };
  let out = run(tuning);
  const rowsFail = out.invoice?.checks.some((c) => c.name === "line-arithmetic" && !c.ok);
  if (ask && (review === "numbers" || (review === "auto" && rowsFail))) {
    const extract = (d, o) => pdf.extractTextWithPositions(d, { ...o, tuning });
    const { numberGap } = await extractWithLlmCheck(extract, bytes, ask);
    out = run([tuning, `number_gap=${numberGap}`].filter(Boolean).join(","));
  }
  return compact(out); // see 6.3
}
```

### 6.3 `export_invoice` (when the result goes to a file or a database)

```json
{
  "name": "export_invoice",
  "description": "Parse an invoice PDF and save its lines. Returns a summary and the checks, not the rows.",
  "input_schema": {
    "type": "object",
    "properties": {
      "format": { "type": "string", "enum": ["csv", "db"], "description": "csv: a file for Excel; db: insert the rows" },
      "tuning": { "type": "string", "description": "<same knob text as extract_pdf>" }
    },
    "required": ["format"]
  }
}
```

Handler: `parseInvoice` → `toRecords` → write `toCsv(records)` or insert →
return `{ ...invoiceInfo(invoice), rows: records.length, checks, saved_to }`.
Refuse or warn (your choice, decide it in the handler, not in the prompt) when
`checks_ok` is false.

### 6.4 What to return to the model

Tool output costs tokens. Return:

- `checks` in full (they are short),
- `header.fields`, `totals`,
- `lines.columns` and the rows as `values` only (drop `cells`/`amounts`),
- for a long table (> ~50 rows), the failed rows plus a count, unless the
  task needs every row.

### 6.5 Instructions to put in the agent's system prompt

```
You can read PDFs with extract_pdf and parse_invoice.
- Call parse_invoice first for invoices, with no tuning.
- If every check is ok, use the numbers as they are.
- If a check fails, read its diff. Try one targeted fix (review="auto", or one knob
  from the knob list that matches the symptom). Never change more than one knob per retry,
  and never retry more than twice.
- A failing check after that is a finding, not a bug to hide: report the row or total,
  the expected value and the printed value.
- To save lines to a file or a database, use export_invoice; don't copy rows yourself.
- If pdfType is Scanned or ImageBased, say OCR is needed; don't invent text.
- Hebrew text is already in logical order; don't reverse it.
```

---

## 7. Coordinates and RTL notes

- Points from the page's bottom-left; `y` is the baseline of horizontal text.
- `rotation`: 0 upright, 90 reads upward, 270 reads downward. Vertical runs
  have `width` = em and `height` = length.
- Text in items and Markdown is in **logical** (reading) order. Cells of an
  RTL table are listed rightmost first.
- Markdown joins side-by-side blocks into one paragraph; use
  `header.blocks` from the invoice layer when blocks matter.

---

## 8. Known limits

- Multi-line table cells: no sample in the corpus, untested.
- Scanned invoices: detected and reported; the invoice layer is untested on OCR output.
- Firecrawl's own regression set (`pdf-evals`) is not available here; the
  in-repo tests and the invoice corpus (`he/fixtures/invoices`) are.
- The LLM review and the repair layer were tested with mocked answers, not a live model.
- Edge package (`pdf-inspector-he-edge`, wasm embedded as text, `await load()`):
  tested in Deno locally, not yet inside a deployed Supabase function.

## 9. Adding a new invoice layout

1. Anonymize it: `python he/tools/anonymize_pdf.py in.pdf out.pdf --names names.txt` (names list stays out of git).
2. Check by hand that the table and totals are right.
3. Add it to `he/fixtures/invoices/expectations.json` (`itemRows`, `columns`, `checks`, `fields`).
4. `node he/regression.mjs --update`, review the diff, commit.
5. If a check fails, fix the extractor or `invoice.mjs`, not the expectation.
