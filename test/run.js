#!/usr/bin/env node
"use strict";

/**
 * Two layers of tests, each run against both transports.
 *
 * The raw layer speaks JSON-RPC at the server directly, which is the only way
 * to check things a well-behaved client never does — malformed JSON, unknown
 * methods, notifications that must not be answered, oversized bodies.
 *
 * The client layer drives the server with the official @modelcontextprotocol
 * SDK. That is the test that matters: this server implements the protocol by
 * hand, so "works against the real client" is the claim being made, and
 * nothing short of the real client can support it. The HTTP section repeats
 * the handshake through StreamableHTTPClientTransport for the same reason.
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

/**
 * Signal a running server and report how it exited, and how long that took.
 * The duration is the assertion that matters: a server that ignores the signal
 * is killed by the harness rather than exiting, which is exactly what `docker
 * stop` does ten seconds later.
 */
function stopWithSignal(proc, signal) {
  return new Promise((resolve) => {
    const started = Date.now();
    proc.on("close", (code, sig) => resolve({ code, signal: sig, ms: Date.now() - started }));
    proc.kill(signal);
  });
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

/**
 * Start a stdio session and leave stdin open, so nothing but a signal can end
 * it. `rawSession` closes stdin, which the server already exits on; this is the
 * other case, and the one a container produces.
 */
function startStdio() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("server never printed its banner; stderr was: " + err));
    }, 15000);
    // Nothing arrives on stdout here, but an unread pipe is never seen to end,
    // and `close` waits for the stdio streams as well as the exit.
    proc.stdout.resume();
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => {
      err += c;
      if (!/ready —/.test(err)) return;
      clearTimeout(timer);
      resolve(proc);
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
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

  const stopped = await stopWithSignal(await startStdio(), "SIGTERM");
  check("SIGTERM ends a stdio session rather than being ignored",
    stopped.code === 0 && stopped.ms < 5000, `exit ${stopped.code}/${stopped.signal} after ${stopped.ms}ms`);
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

  // A natural-language question is mostly filler; the ranking has to survive it.
  c = await call("search_notes", { query: "how much land can a faction claim", limit: 4 });
  check("stopwords do not drown a natural-language question",
    c.json.results.some((n) => n.id === "claimed-chunk" || n.id === "demesne-limit"),
    c.json.results.map((n) => n.id).join(", "));
  check("results carry links, so a near miss is one hop from the answer",
    c.json.results.every((n) => Array.isArray(n.links)));

  c = await call("search_notes", { query: "what is a vassal" });
  check("a definitional question finds the note that defines it",
    c.json.results[0].id === "vassalage", c.json.results[0].id);

  c = await call("get_note", { id: "demesne-limit" });
  check("get_note returns Markdown", c.json && typeof c.json.markdown === "string" && c.json.markdown.length > 200);
  check("get_note returns citations with pinned permalinks",
    c.json.sources.length > 0 && c.json.sources.every((s) => /\/blob\/[0-9a-f]{40}\//.test(s.url)));
  check("get_note reports links and backlinks", Array.isArray(c.json.links) && Array.isArray(c.json.backlinks));

  c = await call("get_note", { id: "does-not-exist" });
  check("get_note flags an unknown id as an error", c.r.isError === true, JSON.stringify(c.r.isError));

  c = await call("list_maps", {});
  check("list_maps returns the hierarchy", c.json && c.json.maps.length === 7, c.json && String(c.json.maps.length));
  check("list_maps reports which commit of the collection it served",
    c.json.collection && /^[0-9a-f]{40}$/.test(c.json.collection.ref || ""),
    JSON.stringify(c.json.collection));
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

/* ----------------------------------------------------- streamable HTTP */

/**
 * Start the HTTP transport on an OS-assigned port and wait for it to say where
 * it landed. `--port 0` keeps concurrent runs from fighting over a fixed one.
 */
function startHttp(argv, env) {
  return new Promise((resolve, reject) => {
    const args = [SERVER].concat(argv || ["--http", "--port", "0"]);
    const proc = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: Object.assign({}, process.env, env || {}),
    });
    let err = "", out = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("server never reported a listening address; stderr was: " + err));
    }, 15000);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => {
      err += c;
      const m = err.match(/listening on (http:\/\/\S+)/);
      if (!m) return;
      clearTimeout(timer);
      resolve({
        proc,
        url: m[1],
        base: new URL(m[1]).origin,
        stderr: () => err,
        stdout: () => out,
        stop: () => proc.kill(),
      });
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Run the server to completion and report what it said and how it exited. */
function runServer(argv) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER].concat(argv), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, out, err }));
  });
}

/** POST one JSON-RPC message the way a client would, and report what came back. */
async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers || {}),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* empty or non-JSON body */ }
  return { res, text, json };
}

async function httpTests() {
  process.stdout.write("\nstreamable HTTP\n");

  // The arguments have to be refused before the collection is loaded, or a
  // typo becomes a server listening somewhere nobody meant it to.
  let ran = await runServer(["--help"]);
  check("--help describes both transports on stderr",
    ran.code === 0 && /--http/.test(ran.err) && ran.out === "", `exit ${ran.code}`);

  ran = await runServer(["--htp"]);
  check("an unknown argument is refused rather than ignored",
    ran.code === 2 && /Unknown argument/.test(ran.err), `exit ${ran.code}: ${ran.err.slice(0, 60)}`);

  ran = await runServer(["--http", "--port", "not-a-port"]);
  check("a port that is not a number is refused",
    ran.code === 2 && /port number/.test(ran.err), `exit ${ran.code}: ${ran.err.slice(0, 60)}`);

  const server = await startHttp();
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

  try {
    let r = await postJson(server.url, init);
    check("HTTP POST returns a JSON-RPC response",
      r.res.status === 200 && r.json.result.serverInfo.name === "dpc-mcp-server", String(r.res.status));
    check("the reply is application/json",
      /^application\/json/.test(r.res.headers.get("content-type") || ""), r.res.headers.get("content-type"));
    check("the negotiated protocol version comes back as a header",
      r.res.headers.get("mcp-protocol-version") === "2024-11-05", r.res.headers.get("mcp-protocol-version"));

    r = await postJson(server.url, { jsonrpc: "2.0", method: "notifications/initialized" });
    check("a notification is accepted with 202 and no body",
      r.res.status === 202 && r.text === "", `${r.res.status} ${r.text.slice(0, 40)}`);

    r = await postJson(server.url, [
      { jsonrpc: "2.0", id: 7, method: "ping" },
      { jsonrpc: "2.0", id: 8, method: "ping" },
    ]);
    check("batched requests get a batched reply over HTTP",
      Array.isArray(r.json) && r.json.length === 2, r.text.slice(0, 80));

    r = await postJson(server.url, "{ this is not json");
    check("malformed JSON is a 400 with a parse error",
      r.res.status === 400 && r.json.error.code === -32700, `${r.res.status} ${r.text.slice(0, 60)}`);

    r = await postJson(server.url, init, { "content-type": "text/plain" });
    check("a non-JSON content type is refused with 415", r.res.status === 415, String(r.res.status));

    r = await postJson(server.url, init, { accept: "text/plain" });
    check("an Accept this server cannot satisfy is refused with 406", r.res.status === 406, String(r.res.status));

    r = await postJson(server.url, init, { "mcp-protocol-version": "1999-01-01" });
    check("an unsupported MCP-Protocol-Version is refused with 400",
      r.res.status === 400 && /2024-11-05/.test(r.text), `${r.res.status} ${r.text.slice(0, 80)}`);

    r = await postJson(server.url, init, { "mcp-protocol-version": "2025-06-18" });
    check("a supported MCP-Protocol-Version is honoured", r.res.status === 200, String(r.res.status));

    const big = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_notes", arguments: { query: "x".repeat(70 * 1024) } } };
    r = await postJson(server.url, big);
    check("an oversized body is refused with 413 rather than buffered",
      r.res.status === 413, String(r.res.status));

    r = await postJson(server.url, init, { origin: "https://evil.example" });
    check("an unexpected Origin is refused with 403", r.res.status === 403, String(r.res.status));

    r = await postJson(server.url, init, { origin: "http://localhost:5173" });
    check("a loopback Origin is allowed", r.res.status === 200, String(r.res.status));

    let res = await fetch(server.url, { method: "GET" });
    check("GET /mcp is 405, not a hanging stream",
      res.status === 405 && res.headers.get("allow") === "POST", String(res.status));
    await res.text();

    res = await fetch(server.base + "/healthz");
    const health = await res.json();
    check("the healthcheck answers without authentication",
      res.status === 200 && health.status === "ok", String(res.status));
    check("the healthcheck names the commit of the collection it serves",
      /^[0-9a-f]{40}$/.test(health.collection || ""), String(health.collection));

    res = await fetch(server.base + "/nope");
    check("an unknown path is 404 with a pointer to /mcp",
      res.status === 404 && /\/mcp/.test(await res.text()), String(res.status));

    check("the HTTP transport writes nothing to stdout", server.stdout() === "", server.stdout().slice(0, 60));

    // The claim this transport makes is that the official client can drive it,
    // exactly as the stdio layer claims for stdio.
    let Client, StreamableHTTPClientTransport;
    try {
      ({ Client } = require("@modelcontextprotocol/sdk/client/index.js"));
      ({ StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js"));
    } catch (e) {
      process.stdout.write("  SKIP  @modelcontextprotocol/sdk not installed (run: npm install)\n");
      return;
    }

    const client = new Client({ name: "dpc-mcp-server-tests", version: "0.1.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));

    const info = client.getServerVersion();
    check("the SDK client completes the handshake over HTTP", info && info.name === "dpc-mcp-server", JSON.stringify(info));

    const { tools } = await client.listTools();
    check("tools are discoverable over HTTP", tools.length === 6, String(tools.length));

    const called = await client.callTool({ name: "get_note", arguments: { id: "faction-power" } });
    const note = JSON.parse(called.content.map((c) => c.text).join(""));
    check("a tool call round-trips over HTTP", note.id === "faction-power", String(note.id));

    const read = await client.readResource({ uri: "dpc-zettelkasten://note/faction-power" });
    check("a resource reads over HTTP", read.contents[0].text.startsWith("---\n"));

    await client.close();
  } finally {
    server.stop();
  }

  // The deployed shape: no arguments at all, the transport and its allowlist
  // chosen by environment, as a container passes them.
  const configured = await startHttp([], { MCP_HTTP_PORT: "0", MCP_HTTP_ORIGINS: "https://mcp.example" });
  try {
    check("$MCP_HTTP_PORT selects the HTTP transport on its own", /listening on http/.test(configured.stderr()));

    let r = await postJson(configured.url, init, { origin: "https://mcp.example" });
    check("an origin named in $MCP_HTTP_ORIGINS is allowed", r.res.status === 200, String(r.res.status));

    r = await postJson(configured.url, init, { origin: "https://other.example" });
    check("an origin outside $MCP_HTTP_ORIGINS is still refused", r.res.status === 403, String(r.res.status));
  } finally {
    configured.stop();
  }

  // How a container stops this server. Node as PID 1 ignores a signal it has
  // installed no handler for, so an unhandled SIGTERM costs `docker stop` its
  // whole ten-second grace period and then a SIGKILL.
  const stopping = await startHttp();
  const stopped = await stopWithSignal(stopping.proc, "SIGTERM");
  check("SIGTERM closes the HTTP transport and exits cleanly",
    stopped.code === 0 && stopped.ms < 5000, `exit ${stopped.code}/${stopped.signal} after ${stopped.ms}ms`);
  check("the shutdown is announced on stderr, not stdout",
    /shutting down/.test(stopping.stderr()) && stopping.stdout() === "", stopping.stdout().slice(0, 60));
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
  check("the engine exposes notes and meta for the server to build on",
    engine.notes && engine.meta && Object.keys(engine.notes).length === ids.length);

  // The vendored snapshot must record which commit it came from. Without this
  // there is no way to tell a current copy from one that is months behind, and
  // a CDN-cached fetch can silently vendor a stale file.
  const src = require(path.join(ROOT, "vendor", "SOURCE.json"));
  check("the snapshot records its origin repository", src.repo === "Dans-Plugins/dpc-zettelkasten", src.repo);
  check("the snapshot is pinned to a 40-character commit SHA", /^[0-9a-f]{40}$/.test(src.ref || ""), String(src.ref));
  check("the recorded note count matches the data", src.noteCount === ids.length,
    `${src.noteCount} vs ${ids.length}`);
}

/* -------------------------------------------------------------------- */

(async () => {
  process.stdout.write("dpc-mcp-server tests\n");
  dataTests();
  await rawTests();
  await clientTests();
  await httpTests();

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    process.stdout.write("\nfailures:\n" + failures.map((f) => "  - " + f).join("\n") + "\n");
    process.exit(1);
  }
})().catch((e) => {
  console.error("\ntest harness error:", e);
  process.exit(1);
});
