#!/usr/bin/env node
// pdf-inspector-he as an MCP server (stdio), so an agent — Claude Code, Claude
// Desktop, any MCP client — connects to the invoice tools directly:
//
//   claude mcp add pdf-inspector-he -- node /path/to/pdf-inspector-he/he/mcp-server.mjs --root ~/invoices
//
// Options:
//   --root DIR        files are named relative to DIR and must stay inside it (default: the cwd)
//   --engine SPEC     cli (the repo's target/release/pdf2md, else pdf2md on PATH) | cli:<path> | wasm:<edge dir>
//   --no-export       do not offer export_invoice (read-only server)
//
// The protocol is JSON-RPC 2.0, one message per line on stdin/stdout
// (MCP stdio transport); logs go to stderr only. No dependencies.
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createInvoiceAgent, resultText } from "./agent.mjs";
import { engineFromSpec } from "./engines.mjs";

const SERVER = { name: "pdf-inspector-he", version: "1.0.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** A path named by the client, inside `root` (symlinks resolved), or an error. */
export function insideRoot(root, name, { mustExist = true } = {}) {
  if (typeof name !== "string" || !name) throw new Error("file is required");
  const full = resolve(root, name);
  // A file to be written does not exist yet: resolve its folder instead.
  const real = mustExist ? realpathSync(full) : resolve(realpathSync(dirname(full)), basename(full));
  const rel = relative(realpathSync(root), real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${name} is outside the server's root`);
  return real;
}

/** The request handler, separate from stdio so tests can drive it. */
export async function createServer({ root = process.cwd(), engine, allowExport = true } = {}) {
  const agent = createInvoiceAgent({
    engine,
    readFile: (file) => {
      const path = insideRoot(root, file);
      if (!/\.pdf$/i.test(path)) throw new Error(`${file} is not a .pdf`);
      return new Uint8Array(readFileSync(path));
    },
    writeFile: allowExport
      ? (out, text) => {
          if (!/\.(json|csv)$/i.test(out)) throw new Error("out must end in .json or .csv");
          mkdirSync(dirname(resolve(root, out)), { recursive: true });
          const path = insideRoot(root, out, { mustExist: false });
          writeFileSync(path, text);
          return relative(realpathSync(root), path);
        }
      : undefined,
  });

  return async function handle(message) {
    const { id, method, params } = message ?? {};
    const isRequest = id !== undefined && id !== null;
    const reply = (result) => (isRequest ? { jsonrpc: "2.0", id, result } : null);
    const fail = (code, msg) => (isRequest ? { jsonrpc: "2.0", id, error: { code, message: msg } } : null);
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions: agent.instructions,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: agent.mcpTools });
      case "tools/call": {
        const { ok, result } = await agent.call(params?.name, params?.arguments ?? {});
        const out = { content: [{ type: "text", text: resultText(result) }], isError: !ok };
        if (ok && result && typeof result === "object" && !("csv" in result)) out.structuredContent = result;
        return reply(out);
      }
      default:
        if (typeof method === "string" && method.startsWith("notifications/")) return null;
        return fail(-32601, `method not found: ${method}`);
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const root = resolve(option(args, "--root") ?? process.cwd());
  if (!existsSync(root)) throw new Error(`--root ${root} does not exist`);
  const engine = await engineFromSpec(option(args, "--engine"));
  const handle = await createServer({ root, engine, allowExport: !args.includes("--no-export") });
  const send = (msg) => msg && process.stdout.write(JSON.stringify(msg) + "\n");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // One message at a time, in order: a tools/call can take a second, and the
  // answers must not overtake each other.
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        return;
      }
      try {
        send(await handle(message));
      } catch (e) {
        console.error("pdf-inspector-he:", e);
        if (message?.id != null) send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(e?.message ?? e) } });
      }
    });
  });
  lines.on("close", () => queue.then(() => engine.close?.()));
  console.error(`pdf-inspector-he MCP server: root ${root}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
