#!/usr/bin/env node
"use strict";

/**
 * Two layers of tests.
 *
 * The raw layer speaks JSON-RPC at the server directly, which is the only way
 * to check things a well-behaved client never does — malformed JSON, unknown
 * methods, notifications that must not be answered.
 *
 * The client layer drives the server with the official @modelcontextprotocol
 * SDK. That is the test that matters: this server implements the protocol by
 * hand, so "works against the real client" is the claim being made, and
 * nothing short of the real client can support it.
 */

const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "src", "server.js");

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; process.stdout.write(`  ok   ${name}\n`); }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

/* ------------------------------------------------------------ raw layer */

function rawSession(lines) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", reject);
    proc.on("close", () => {
      const msgs = out.split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (e) { return { __unparsed: l }; }
      });
      resolve({ msgs, err, out });
    });
    for (const l of lines) proc.stdin.write(typeof l === "string" ? l + "\n" : JSON.stringify(l) + "\n");
    proc.stdin.end();
  });
}

async function rawTests() {
  process.stdout.write("\nraw JSON-RPC\n");

  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

  let r = await rawSession([
    init,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
  ]);
  check("initialize returns serverInfo", r.msgs[0] && r.msgs[0].result && r.msgs[0].result.serverInfo.name === "dpc-mcp-server");
  check("initialize echoes a supported protocol version", r.msgs[0].result.protocolVersion === "2024-11-05", r.msgs[0].result.protocolVersion);
  check("notification produces no response", r.msgs.length === 3, `got ${r.msgs.length} messages`);
  check("tools/list returns tools", r.msgs[1].result.tools.length >= 5, String(r.msgs[1].result.tools.length));
  check("every tool has a description and schema",
    r.msgs[1].result.tools.every((t) => t.name && t.description && t.inputSchema && t.inputSchema.type === "object"));
  check("ping answers", r.msgs[2] && r.msgs[2].result && Object.keys(r.msgs[2].result).length === 0);
  check("nothing but JSON on stdout", r.msgs.every((m) => !m.__unparsed));
  check("startup banner goes to stderr", /notes/.test(r.err));

  r = await rawSession([init, "{ this is not json", { jsonrpc: "2.0", id: 9, method: "tools/list" }]);
  check("malformed JSON gets a parse error", r.msgs.some((m) => m.error && m.error.code === -32700));
  check("server survives malformed JSON", r.msgs.some((m) => m.id === 9 && m.result));

  r = await rawSession([init, { jsonrpc: "2.0", id: 4, method: "no/such/method" }]);
  check("unknown method returns -32601", r.msgs[1].error && r.msgs[1].error.code === -32601, JSON.stringify(r.msgs[1]));

  r = await rawSession([init, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } }]);
  check("unknown tool is an error", !!r.msgs[1].error, JSON.stringify(r.msgs[1]).slice(0, 120));

  r = await rawSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
  ]);
  check("a newer protocol version is echoed back", r.msgs[0].result.protocolVersion === "2025-06-18", r.msgs[0].result.protocolVersion);

  r = await rawSession([init, [{ jsonrpc: "2.0", id: 7, method: "ping" }, { jsonrpc: "2.0", id: 8, method: "ping" }]]);
  check("batched requests get a batched reply", Array.isArray(r.msgs[1]) && r.msgs[1].length === 2, JSON.stringify(r.msgs[1]));
}

/* --------------------------------------------------------- client layer */

async function clientTests() {
  process.stdout.write("\nofficial MCP SDK client\n");
  let Client, StdioClientTransport;
  try {
    ({ Client } = require("@modelcontextprotocol/sdk/client/index.js"));
    ({ StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js"));
  } catch (e) {
    process.stdout.write("  SKIP  @modelcontextprotocol/sdk not installed (run: npm install)\n");
    return;
  }

  const transport = new StdioClientTransport({ command: "node", args: [SERVER] });
  const client = new Client({ name: "dpc-mcp-server-tests", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const info = client.getServerVersion();
  check("SDK client completes the handshake", info && info.name === "dpc-mcp-server", JSON.stringify(info));

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check("tools are discoverable", names.join(",") ===
    "get_citations,get_note,get_schema,graphql,list_maps,search_notes", names.join(","));
  check("the graphql tool ships the schema in its description",
    tools.find((t) => t.name === "graphql").description.includes("type Note"));

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const body = r.content.map((c) => c.text).join("");
    let json = null;
    try { json = JSON.parse(body); } catch (e) { /* plain text result */ }
    return { r, body, json };
  };

  let c = await call("search_notes", { query: "power" });
  check("search_notes finds notes", c.json && c.json.results.length > 0, c.body.slice(0, 120));
  check("search_notes ranks a title match first",
    c.json.results[0].id === "faction-power" || c.json.results[0].id === "player-power",
    c.json.results[0] && c.json.results[0].id);

  c = await call("search_notes", { query: "power", type: "moc", limit: 3 });
  check("search_notes honours type and limit",
    c.json.results.every((n) => n.type === "moc") && c.json.results.length <= 3);

  c = await call("get_note", { id: "demesne-limit" });
  check("get_note returns Markdown", c.json && typeof c.json.markdown === "string" && c.json.markdown.length > 200);
  check("get_note returns citations with pinned permalinks",
    c.json.sources.length > 0 && c.json.sources.every((s) => /\/blob\/[0-9a-f]{40}\//.test(s.url)));
  check("get_note reports links and backlinks", Array.isArray(c.json.links) && Array.isArray(c.json.backlinks));

  c = await call("get_note", { id: "does-not-exist" });
  check("get_note flags an unknown id as an error", c.r.isError === true, JSON.stringify(c.r.isError));

  c = await call("list_maps", {});
  check("list_maps returns the hierarchy", c.json && c.json.maps.length === 7, c.json && String(c.json.maps.length));
  check("every concept has a home in list_maps",
    c.json.maps.reduce((n, m) => n + m.concepts.length, 0) === c.json.totals.concepts,
    `${c.json.maps.reduce((n, m) => n + m.concepts.length, 0)} vs ${c.json.totals.concepts}`);

  c = await call("graphql", { query: "{ notes(orderBy: degree, first: 3) { title degree } }" });
  check("graphql runs a query", c.json && c.json.data.notes.length === 3, c.body.slice(0, 120));
  check("graphql reports the notes a query touched", c.json.notesTouched.length === 3);

  c = await call("graphql", { query: "{ notes { nope } }" });
  check("a bad graphql query is an error, not a crash", c.r.isError === true);
  check("a bad graphql query returns the schema to recover with", c.body.includes("type Note"));

  c = await call("graphql", { query: "mutation { x }" });
  check("mutations are refused", c.r.isError === true && /read-only/.test(c.body));

  c = await call("get_citations", { repo: "Ponder" });
  check("get_citations filters by repository",
    c.json.count > 0 && c.json.citations.every((x) => x.repo.includes("Ponder")), String(c.json.count));

  c = await call("get_schema", {});
  check("get_schema returns SDL", c.body.includes("type Query") && c.body.includes("enum NoteType"));

  const { resources } = await client.listResources();
  check("every note is exposed as a resource", resources.length === 45, String(resources.length));
  check("resource uris use the expected scheme",
    resources.every((r) => r.uri.startsWith("dpc-zettelkasten://note/")));

  const read = await client.readResource({ uri: "dpc-zettelkasten://note/faction-power" });
  check("a resource reads as Markdown with frontmatter",
    read.contents[0].mimeType === "text/markdown" && read.contents[0].text.startsWith("---\n"));
  check("resource frontmatter carries the citations", read.contents[0].text.includes("claim:"));

  let threw = false;
  try { await client.readResource({ uri: "dpc-zettelkasten://note/nope" }); } catch (e) { threw = true; }
  check("reading an unknown resource errors", threw);

  await client.close();
}

/* ------------------------------------------------------------ data layer */

function dataTests() {
  process.stdout.write("\nvendored data\n");
  const { createEngine } = require(path.join(ROOT, "vendor", "zk-graphql.js"));
  const dataset = require(path.join(ROOT, "vendor", "dataset.json"));
  const engine = createEngine(dataset);
  const notes = dataset.notes;
  const ids = Object.keys(notes);

  check("dataset has notes", ids.length > 0, String(ids.length));
  check("meta agrees with the note count", dataset.meta.noteCount === ids.length);
  check("every note carries a Markdown body", ids.every((i) => typeof notes[i].body === "string" && notes[i].body.length));
  check("every concept cites at least one source",
    ids.filter((i) => notes[i].type === "concept").every((i) => notes[i].sources.length > 0));
  check("every citation is pinned to a 40-character SHA",
    ids.every((i) => notes[i].sources.every((s) => /^[0-9a-f]{40}$/.test(s.ref))));
  check("every citation points at a Dans-Plugins repository",
    ids.every((i) => notes[i].sources.every((s) => s.repo.startsWith("Dans-Plugins/"))));
  check("every wikilink resolves", ids.every((i) => notes[i].links.every((t) => notes[t])));
  check("every concept declares a home MOC that exists",
    ids.filter((i) => notes[i].type === "concept").every((i) => notes[notes[i].moc]));
  check("the engine's schema covers every type",
    ["type Query", "type Note", "type Source", "type Tag", "type Repository", "type Stats"]
      .every((t) => engine.sdl().includes(t)));
}

/* -------------------------------------------------------------------- */

(async () => {
  process.stdout.write("dpc-mcp-server tests\n");
  dataTests();
  await rawTests();
  await clientTests();

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    process.stdout.write("\nfailures:\n" + failures.map((f) => "  - " + f).join("\n") + "\n");
    process.exit(1);
  }
})().catch((e) => {
  console.error("\ntest harness error:", e);
  process.exit(1);
});
