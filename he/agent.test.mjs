// The JSON document, the agent tools and the MCP server, on the real corpus
// through the native binary (skipped when target/release/pdf2md is not built;
// CI builds it first). The misread fixture has one digit changed in its
// drawing stream (he/tools/misread_pdf.py): row 11's price prints 37.35 against
// a total of 27.35.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliEngine, defaultBinary } from "./engines.mjs";
import { readInvoice } from "./repair.mjs";
import { DOCUMENT_SCHEMA, invoiceDocument } from "./document.mjs";
import { createInvoiceAgent, invoiceToolDefinitions, parseRows, resultText, toMcpTools } from "./agent.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const skip = !defaultBinary();
const CORPUS = ["print-to-pdf-5p", "priority-1p", "priority-2p", "priority-4p"].map((n) => here(`./fixtures/invoices/${n}.pdf`));
const MISREAD = here("./fixtures/repair/priority-1p.misread-row11.pdf");
const bytes = (p) => new Uint8Array(readFileSync(p));
const schema = JSON.parse(readFileSync(here("./invoice-document.schema.json"), "utf8"));

/** Required keys and types from the JSON Schema, recursively — enough to keep the document and its schema in step. */
function conforms(value, s, path = "$") {
  const types = [s.type].flat().filter(Boolean);
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (types.length && !types.some((t) => t === kind || (t === "number" && kind === "integer"))) {
    throw new Error(`${path}: ${kind} is not ${types.join("|")}`);
  }
  if (s.const !== undefined) assert.equal(value, s.const, path);
  if (s.enum) assert.ok(s.enum.includes(value), `${path}: ${value} not in ${s.enum}`);
  if (kind === "object" && s.properties) {
    for (const k of s.required ?? []) assert.ok(k in value, `${path}.${k} missing`);
    for (const [k, v] of Object.entries(value)) {
      if (s.properties[k]) conforms(v, s.properties[k], `${path}.${k}`);
      else if (path !== "$.repair.schema") throw new Error(`${path}.${k} is not in the schema`);
    }
  }
  if (kind === "array" && s.items) value.forEach((v, i) => conforms(v, s.items, `${path}[${i}]`));
}

test("the JSON document follows its schema on every corpus invoice and on a repairable one", { skip }, () => {
  const engine = cliEngine();
  try {
    for (const pdf of [...CORPUS, MISREAD]) {
      const doc = invoiceDocument(readInvoice(engine, bytes(pdf)));
      conforms(doc, schema);
      assert.equal(doc.schema, DOCUMENT_SCHEMA);
    }
    const ok = invoiceDocument(readInvoice(engine, bytes(CORPUS[1])));
    assert.equal(ok.status, "ok");
    assert.equal(ok.repair, null);
    assert.equal(ok.lines.length, 15);
    assert.ok(ok.lines.some((l) => l.marker) && ok.lines.some((l) => l.is_return));
    const bad = invoiceDocument(readInvoice(engine, bytes(MISREAD)));
    assert.equal(bad.status, "repairable");
    assert.deepEqual(bad.failed_rows, [11]);
    assert.match(bad.repair.prompt, /row 11: 1 x price != 27.35/);
  } finally {
    engine.close();
  }
});

test("agent tools: read, see the failing row, a wrong fix is rejected, the right one closes it", { skip }, async () => {
  const engine = cliEngine();
  const written = new Map();
  const agent = createInvoiceAgent({
    engine,
    readFile: (f) => bytes(f),
    writeFile: (out, text) => {
      written.set(out, text);
      return out;
    },
  });
  try {
    const read = await agent.call("read_invoice", { file: MISREAD });
    assert.equal(read.ok, true);
    assert.equal(read.result.status, "repairable");
    assert.deepEqual(read.result.failed_rows, [11]);
    assert.match(read.result.failing_rows_csv, /\n11,11,1,SH22039076,SAB-11223,"פלס מגנטי TRUPER ""9",1,יח',37.35,,,27.35,off by -10/);
    assert.match(read.result.next, /fix_rows/);

    const wrong = await agent.call("fix_rows", { file: MISREAD, fixes: [{ row: 11, quantity: 1, unit_price: 37.35, discount_pct: 0, line_total: 37.35, why: "guess" }] });
    assert.equal(wrong.result.status, "repairable", "the total now disagrees with the printed sum");
    // The row itself closes, so it is kept; the sum check is what still fails.
    assert.equal(wrong.result.checks.find((c) => c.name === "lines-sum").ok, false);

    // Read again (resets), then the right correction.
    await agent.call("read_invoice", { file: MISREAD });
    const right = await agent.call("fix_rows", { file: MISREAD, fixes: [{ row: 11, quantity: 1, unit_price: 27.35, discount_pct: 0, line_total: 27.35, why: "first digit read as 3" }] });
    assert.equal(right.result.status, "ok");
    assert.deepEqual(right.result.applied, [{ row: 11, why: "first digit read as 3" }]);

    const rows = await agent.call("get_rows", { file: MISREAD, rows: "11" });
    assert.match(resultText(rows.result), /\n11,11,1,.*,27.35,,,27.35,ok$/);
    const doc = await agent.call("get_invoice_json", { file: MISREAD });
    assert.equal(doc.result.status, "ok");
    assert.deepEqual(doc.result.repaired, [11]);
    assert.equal(doc.result.lines[10].repaired, "first digit read as 3");

    const exported = await agent.call("export_invoice", { file: MISREAD, format: "json", out: "out.json" });
    assert.equal(exported.result.status, "ok");
    assert.equal(JSON.parse(written.get("out.json")).lines[10].unit_price, 27.35);

    assert.equal((await agent.call("nope", {})).ok, false);
    assert.match((await agent.call("read_invoice", {})).result.error, /file is required/);
    assert.ok((await agent.call("list_knobs", {})).result.knobs.some((k) => k.name === "latin_digit_split"));
  } finally {
    engine.close();
  }
});

test("tool definitions: Anthropic and MCP forms, export only when the host can write", () => {
  const all = invoiceToolDefinitions();
  assert.deepEqual(all.map((t) => t.name), ["read_invoice", "get_rows", "fix_rows", "extract_text", "get_invoice_json", "list_knobs", "export_invoice"]);
  assert.ok(!invoiceToolDefinitions({ withExport: false }).some((t) => t.name === "export_invoice"));
  for (const t of toMcpTools(all)) assert.equal(t.inputSchema.type, "object");
  assert.deepEqual(parseRows("2-4,9", 10, []), [1, 2, 3, 8]);
  assert.deepEqual(parseRows("failed", 10, [5]), [5]);
  assert.equal(parseRows("all", 3, []).length, 3);
  assert.throws(() => parseRows("x", 3, []), /not a number/);
});

/** Talk to the MCP server over real stdio, one JSON-RPC line per message. */
function mcp(args) {
  const child = spawn(process.execPath, [here("./mcp-server.mjs"), ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (d) => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  return {
    request(method, params) {
      const n = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      return new Promise((res) => pending.set(n, res));
    },
    notify(method) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    },
    close() {
      child.stdin.end();
      return new Promise((res) => child.on("close", res));
    },
  };
}

test("MCP server over stdio: initialize, list, read, fix, stay inside the root", { skip }, async () => {
  const out = mkdtempSync(join(tmpdir(), "pdfhe-mcp-"));
  const server = mcp(["--root", here("./fixtures")]);
  try {
    const init = await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "pdf-inspector-he");
    assert.match(init.result.instructions, /read_invoice/);
    server.notify("notifications/initialized");

    const list = await server.request("tools/list", {});
    assert.equal(list.result.tools.length, 7);
    assert.ok(list.result.tools.every((t) => t.inputSchema));

    const file = "repair/priority-1p.misread-row11.pdf";
    const read = await server.request("tools/call", { name: "read_invoice", arguments: { file } });
    assert.equal(read.result.isError, false);
    assert.equal(read.result.structuredContent.status, "repairable");
    assert.equal(JSON.parse(read.result.content[0].text).failed_rows[0], 11);

    const fix = await server.request("tools/call", {
      name: "fix_rows",
      arguments: { file, fixes: [{ row: 11, quantity: 1, unit_price: 27.35, discount_pct: 0, line_total: 27.35, why: "digit" }] },
    });
    assert.equal(fix.result.structuredContent.status, "ok");

    const rows = await server.request("tools/call", { name: "get_rows", arguments: { file, rows: "11" } });
    assert.match(rows.result.content[0].text, /^row,line_no/, "CSV comes back as plain text");

    const escape = await server.request("tools/call", { name: "read_invoice", arguments: { file: "../../Cargo.toml" } });
    assert.equal(escape.result.isError, true);
    assert.match(escape.result.content[0].text, /outside the server's root|is not a \.pdf/);

    const exportOut = await server.request("tools/call", { name: "export_invoice", arguments: { file, format: "csv", out: "../x.csv" } });
    assert.equal(exportOut.result.isError, true, "writing outside the root is refused");

    const unknown = await server.request("nope/method", {});
    assert.equal(unknown.error.code, -32601);
    assert.equal((await server.request("ping", {})).result.constructor, Object);
  } finally {
    await server.close();
    rmSync(out, { recursive: true, force: true });
  }
  assert.ok(!existsSync(here("./x.csv")));
});
