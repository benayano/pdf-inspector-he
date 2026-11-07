// Runs the Deno build of the wasm package the way a Supabase Edge Function
// would: `deno run --allow-read he/deno-smoke.ts <pkg-deno dir> <pdf>`.
import { toFileUrl, resolve } from "jsr:@std/path@1";

const [pkgDir, pdfPath] = Deno.args;
const pkg = await import(toFileUrl(resolve(pkgDir, "pdf_inspector.js")).href);
const { findAmbiguousRows } = await import(toFileUrl(resolve(pkgDir, "rtl-check.mjs")).href);

const data = await Deno.readFile(pdfPath);
const result = pkg.processPdf(data, { numberGap: "auto" });
if (result.pdfType !== "TextBased") throw new Error(`pdfType ${result.pdfType}`);

const items = pkg.extractTextWithPositions(data, { numberGap: 0.2 });
if (!Array.isArray(items) || items.length === 0) throw new Error("no items");
const text = items.map((i: { text: string }) => i.text).join(" ");
// "בשנת 2023 נוספו 1,250 משרות חדשות" from the fixture.
if (!text.includes("2023") || !text.includes("1,250")) throw new Error(`unexpected: ${text}`);

let invalid = false;
try {
  pkg.extractTextWithPositions(data, { numberGap: "nope" });
} catch {
  invalid = true;
}
if (!invalid) throw new Error("invalid numberGap was accepted");

const knobs = pkg.listKnobs();
if (!Array.isArray(knobs) || !knobs.some((k: { name: string }) => k.name === "rule_join_gap")) {
  throw new Error("listKnobs is missing knobs");
}
const tuned = pkg.processPdf(data, { tuning: "rule_join_gap=3,short_rule_ratio=auto" });
if (tuned.pdfType !== "TextBased") throw new Error("tuning broke processing");
let badKnob = false;
try {
  pkg.processPdf(data, { tuning: "no_such_knob=1" });
} catch {
  badKnob = true;
}
if (!badKnob) throw new Error("unknown knob was accepted");

const found = await findAmbiguousRows(
  (d: Uint8Array, o: { numberGap: number }) => pkg.extractTextWithPositions(d, o),
  data,
);
console.log(`ok: ${items.length} items, ${found.rowsChecked} rows, ${found.ambiguous.length} ambiguous`);
