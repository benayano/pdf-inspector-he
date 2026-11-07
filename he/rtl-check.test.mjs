import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rowsOf,
  findAmbiguousRows,
  buildPrompt,
  chooseNumberGap,
  extractWithLlmCheck,
} from "./rtl-check.mjs";

// A fake engine: row 1 depends on the gap the way the real bug did
// ("1.2 3" at 0.1/0.2, "3 1.2" at 0.3); row 2 never does.
function fakeExtract(_data, { numberGap }) {
  const desc = numberGap >= 0.3 ? "מסילה 3 1.2 מטר" : "מסילה 1.2 3 מטר";
  return [
    { text: "7", page: 1, x: 540, y: 446, width: 4 },
    { text: desc, page: 1, x: 335, y: 446.2, width: 99 },
    { text: "1,210.10", page: 1, x: 72, y: 446, width: 28 },
    { text: "8", page: 1, x: 540, y: 433, width: 4 },
    { text: "ניילון יציקה", page: 1, x: 335, y: 433, width: 60 },
  ];
}

test("rowsOf groups by baseline and reads right to left", () => {
  const rows = rowsOf(fakeExtract(null, { numberGap: 0.2 }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].cells, ["7", "מסילה 1.2 3 מטר", "1,210.10"]);
});

test("findAmbiguousRows keeps only rows that depend on the gap", async () => {
  const found = await findAmbiguousRows(fakeExtract, null);
  assert.equal(found.rowsChecked, 2);
  assert.equal(found.ambiguous.length, 1);
  assert.equal(found.ambiguous[0].readings["0.3"], "7 | מסילה 3 1.2 מטר | 1,210.10");
});

test("buildPrompt shows distinct readings, not gap values", async () => {
  const found = await findAmbiguousRows(fakeExtract, null);
  const prompt = buildPrompt(found.ambiguous);
  assert.match(prompt, /A: 7 \| מסילה 1\.2 3 מטר/);
  assert.match(prompt, /B: 7 \| מסילה 3 1\.2 מטר/);
  assert.doesNotMatch(prompt, /0\.3/);
});

test("chooseNumberGap follows the LLM and prefers the default on ties", async () => {
  const found = await findAmbiguousRows(fakeExtract, null);
  const pickA = async () => '{"answers":[{"row":1,"choice":"A"}]}';
  const a = await chooseNumberGap(found, pickA);
  assert.equal(a.gap, 0.2); // 0.1 and 0.2 both read A; 0.2 is the default
  const pickB = async () => 'sure: {"answers":[{"row":1,"choice":"B"}]}';
  assert.equal((await chooseNumberGap(found, pickB)).gap, 0.3);
  const unsure = async () => '{"answers":[{"row":1,"choice":"?"}]}';
  assert.equal((await chooseNumberGap(found, unsure)).gap, null);
  const garbage = async () => "no json here";
  assert.equal((await chooseNumberGap(found, garbage)).reason, "llm-undecided");
});

test("no ambiguous rows: the LLM is not asked", async () => {
  let asked = false;
  const steady = () => [{ text: "שורה", page: 1, x: 10, y: 10 }];
  const result = await extractWithLlmCheck(steady, null, async () => {
    asked = true;
    return "";
  });
  assert.equal(asked, false);
  assert.equal(result.numberGap, 0.2);
  assert.equal(result.check.reason, "no-ambiguous-rows");
});

test("extractWithLlmCheck re-extracts the whole document with the chosen gap", async () => {
  const result = await extractWithLlmCheck(
    fakeExtract,
    null,
    async () => '{"answers":[{"row":1,"choice":"B"}]}',
  );
  assert.equal(result.numberGap, 0.3);
  assert.equal(result.rows[0].cells[1], "מסילה 3 1.2 מטר");
});

import { compareTunings, buildTuningPrompt, chooseTuning, extractionToolDefinition } from "./rtl-check.mjs";

// A fake engine whose table loses a column unless rule_join_gap is set.
function fakeMarkdown(_data, { tuning }) {
  const good = /rule_join_gap=4/.test(tuning);
  return [
    "# Invoice",
    good ? "|1|SH1|מסילה|28.00|" : "|1 SH1 מסילה 28.00|",
    good ? "|2|SH1|קרש|8.00|" : "|2 SH1 קרש 8.00|",
    "Total 100",
  ].join("\n");
}

test("compareTunings keeps only the differing lines", async () => {
  const c = await compareTunings(fakeMarkdown, null, ["", "rule_join_gap=4"]);
  assert.equal(c.identical, false);
  assert.deepEqual(c.unique[1], ["|1|SH1|מסילה|28.00|", "|2|SH1|קרש|8.00|"]);
  assert.ok(!buildTuningPrompt(c).includes("Total 100"));
});

test("chooseTuning returns the candidate the LLM picks", async () => {
  const r = await chooseTuning(fakeMarkdown, null, async () => '{"choice":"B","reason":"columns"}', {
    candidates: ["", "rule_join_gap=4"],
  });
  assert.equal(r.tuning, "rule_join_gap=4");
  assert.equal(r.why, "columns");
  const same = await chooseTuning(() => "x", null, async () => "{}", { candidates: ["", "a=1"] });
  assert.equal(same.reason, "identical-outputs");
  const unsure = await chooseTuning(fakeMarkdown, null, async () => '{"choice":"?"}', {
    candidates: ["", "rule_join_gap=4"],
  });
  assert.equal(unsure.tuning, null);
});

test("extractionToolDefinition lists every knob", () => {
  const tool = extractionToolDefinition([{ name: "rule_join_gap", unit: "pt", auto: "2.0", effect: "joins" }]);
  assert.equal(tool.name, "extract_pdf");
  assert.match(tool.input_schema.properties.tuning.description, /rule_join_gap \(pt; auto: 2\.0\): joins/);
});
