#!/usr/bin/env node
"use strict";

/**
 * dpc-mcp-server — serves the DPC Zettelkasten to MCP clients.
 *
 * Loads the collection, builds the GraphQL engine over it, and speaks MCP on
 * stdio, or over Streamable HTTP with `--http`. Nothing is written and nothing
 * is fetched at request time; the graph is read once at startup.
 *
 * Where the data comes from, in order:
 *   1. $DPC_ZK_DATASET   — path to a dataset.json
 *   2. $DPC_ZK_PATH      — path to a dpc-zettelkasten checkout
 *   3. vendor/dataset.json — the copy committed here (default)
 *
 * Run `npm run sync` to refresh the vendored copy from the published
 * collection.
 */

const fs = require("fs");
const path = require("path");

const { Server, text } = require("./protocol.js");
const { build } = require("./tools.js");
const httpTransport = require("./http.js");

const ROOT = path.join(__dirname, "..");
const NAME = "dpc-mcp-server";
const VERSION = require(path.join(ROOT, "package.json")).version;

const RESOURCE_SCHEME = "dpc-zettelkasten";

/**
 * How long a shutdown is allowed to take before the process leaves anyway.
 * Draining what is in flight is the point, but a wedged socket must not turn a
 * fast stop into a hang: a container's stop grace period is ten seconds, and
 * this has to finish well inside it.
 */
const SHUTDOWN_GRACE_MS = 2000;

const USAGE = `${NAME} ${VERSION}

  node src/server.js                 speak MCP on stdio (the default)
  node src/server.js --http          speak MCP over Streamable HTTP

Options:
  --http            serve HTTP instead of stdio; implied by $MCP_HTTP_PORT
  --port <n>        port to listen on (default ${httpTransport.DEFAULT_PORT}, or $MCP_HTTP_PORT)
  --host <addr>     address to bind (default ${httpTransport.DEFAULT_HOST}, or $MCP_HTTP_HOST)
  --help            this text

Environment:
  DPC_ZK_DATASET, DPC_ZK_ENGINE, DPC_ZK_PATH   where the collection is read from
  MCP_HTTP_PORT, MCP_HTTP_HOST, MCP_HTTP_ORIGINS   the HTTP transport

See CONFIG.md.
`;

/**
 * The HTTP transport is opt-in, and binds loopback unless told otherwise: it
 * carries no authentication of its own yet, so exposing it takes a deliberate
 * `--host`, never a side effect of naming a port.
 */
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const value = () => {
      const v = inline === null ? argv[++i] : inline;
      if (v === undefined) throw new Error(`${name} needs a value`);
      return v;
    };
    if (name === "--http") opts.http = true;
    else if (name === "--port") opts.port = port(value());
    else if (name === "--host") opts.host = value();
    else if (name === "--help" || name === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}. Run with --help.`);
  }
  return opts;
}

function port(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`"${value}" is not a port number (0-65535; 0 asks the OS for a free one)`);
  }
  return n;
}

function resolveSources() {
  const candidates = [];
  if (process.env.DPC_ZK_DATASET) {
    candidates.push({
      why: "$DPC_ZK_DATASET",
      dataset: process.env.DPC_ZK_DATASET,
      engine: process.env.DPC_ZK_ENGINE || path.join(ROOT, "vendor", "zk-graphql.js"),
    });
  }
  if (process.env.DPC_ZK_PATH) {
    candidates.push({
      why: "$DPC_ZK_PATH",
      dataset: path.join(process.env.DPC_ZK_PATH, "site", "dataset.json"),
      engine: path.join(process.env.DPC_ZK_PATH, "lib", "zk-graphql.js"),
    });
  }
  candidates.push({
    why: "vendored copy",
    dataset: path.join(ROOT, "vendor", "dataset.json"),
    engine: path.join(ROOT, "vendor", "zk-graphql.js"),
  });
  return candidates;
}

/** Provenance written by tools/sync.js beside a vendored dataset, if present. */
function readSource(datasetPath) {
  const file = path.join(path.dirname(datasetPath), "SOURCE.json");
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

function createEngineFrom(enginePath, dataset) {
  const { createEngine } = require(path.resolve(enginePath));
  const engine = createEngine(dataset);
  if (!engine || !engine.notes || !engine.meta) {
    throw new Error(
      `${enginePath} does not expose notes and meta. It is probably older than ` +
      "this server expects — run `npm run sync` to refresh it."
    );
  }
  return engine;
}

function load() {
  const tried = [];
  for (const c of resolveSources()) {
    if (!fs.existsSync(c.dataset) || !fs.existsSync(c.engine)) {
      tried.push(`${c.why}: ${c.dataset}`);
      continue;
    }
    const dataset = JSON.parse(fs.readFileSync(c.dataset, "utf8"));
    if (!dataset || !dataset.notes || !dataset.meta) {
      throw new Error(`${c.dataset} is not a zettelkasten dataset (expected "notes" and "meta")`);
    }
    const engine = createEngineFrom(c.engine, dataset);
    return { engine, origin: c.why, dataset: c.dataset, source: readSource(c.dataset) };
  }
  throw new Error(
    "No zettelkasten data found. Tried:\n  " + tried.join("\n  ") +
    "\n\nRun `npm run sync` to fetch it, or set DPC_ZK_PATH to a " +
    "dpc-zettelkasten checkout."
  );
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv || process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${NAME}: ${e.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stderr.write(USAGE);
    return;
  }

  let loaded;
  try {
    loaded = load();
  } catch (e) {
    // stderr, never stdout — stdout carries the protocol and a stray line there
    // desynchronises the client.
    process.stderr.write(`${NAME}: ${e.message}\n`);
    process.exit(1);
  }

  const { engine, origin, source } = loaded;
  const tools = build(engine, source);
  const notes = engine.notes;
  const meta = engine.meta;

  const uriFor = (id) => `${RESOURCE_SCHEME}://note/${id}`;

  const handlers = {
    listTools: tools.listTools,
    callTool: tools.callTool,

    // Each note is also a resource, so a client can attach one to a
    // conversation without spending a tool call on it.
    listResources: () =>
      Object.keys(notes).sort().map((id) => ({
        uri: uriFor(id),
        name: notes[id].title,
        description: notes[id].summary,
        mimeType: "text/markdown",
      })),

    listResourceTemplates: () => [{
      uriTemplate: `${RESOURCE_SCHEME}://note/{id}`,
      name: "Zettelkasten note",
      description: "One note as Markdown, frontmatter included.",
      mimeType: "text/markdown",
    }],

    readResource: (uri) => {
      const prefix = `${RESOURCE_SCHEME}://note/`;
      if (!uri.startsWith(prefix)) {
        const e = new Error(`Unsupported uri: ${uri}. Expected ${prefix}<id>`);
        e.code = -32602;
        throw e;
      }
      const id = decodeURIComponent(uri.slice(prefix.length));
      const note = notes[id];
      if (!note) {
        const e = new Error(`No note with id "${id}"`);
        e.code = -32602;
        throw e;
      }
      // Reconstruct the file as it sits in the repository: frontmatter first,
      // so the citations travel with the prose.
      const front = [
        "---",
        `id: ${note.id}`,
        `title: ${note.title}`,
        `type: ${note.type}`,
        note.moc ? `moc: ${note.moc}` : null,
        `summary: ${note.summary}`,
        note.sources.length ? "sources:" : null,
        ...note.sources.map((s) =>
          `  - ${s.repo} ${s.path}${s.lines ? ":" + s.lines : ""} @ ${s.ref}\n` +
          `    claim: ${s.claim}\n` +
          `    url: ${s.url}`),
        "---",
        "",
      ].filter((l) => l !== null).join("\n");

      return {
        contents: [{
          uri,
          mimeType: "text/markdown",
          text: front + note.body,
        }],
      };
    },
  };

  const server = new Server({ name: NAME, version: VERSION }, handlers);

  const pin = source && source.ref ? ` @ ${source.ref.slice(0, 10)}` : "";
  const banner =
    `${NAME} ${VERSION} ready — ${meta.noteCount} notes, ${meta.citationCount} citations ` +
    `across ${meta.repos.length} repositories (${origin}${pin})`;

  if (args.http || process.env.MCP_HTTP_PORT) {
    await serveHttp(server, args, { meta, source, banner });
    return;
  }

  server.listen(process.stdin, process.stdout);
  process.stderr.write(`${banner}\n`);
  process.stdin.on("end", () => process.exit(0));
  // There is no socket to stop accepting on, so closing means stop reading;
  // `consume()` is dispatched without being awaited, so a reply already being
  // computed gets the turn of the loop it needs to be written.
  onShutdown((done) => {
    process.stdin.pause();
    setImmediate(done);
  });
}

async function serveHttp(server, args, ctx) {
  const host = args.host || process.env.MCP_HTTP_HOST || httpTransport.DEFAULT_HOST;
  let wanted;
  try {
    wanted = args.port !== undefined ? args.port
      : process.env.MCP_HTTP_PORT ? port(process.env.MCP_HTTP_PORT)
      : httpTransport.DEFAULT_PORT;
  } catch (e) {
    process.stderr.write(`${NAME}: $MCP_HTTP_PORT ${e.message}\n`);
    process.exit(2);
  }

  let listener;
  try {
    listener = await httpTransport.listen(server, {
      host,
      port: wanted,
      allowedOrigins: httpTransport.parseOrigins(process.env.MCP_HTTP_ORIGINS),
      // Unauthenticated, so it says only what a probe needs: that the process
      // is up, and which commit of the collection it is serving.
      health: () => ({
        name: NAME,
        version: VERSION,
        notes: ctx.meta.noteCount,
        collection: ctx.source && ctx.source.ref ? ctx.source.ref : null,
      }),
    });
  } catch (e) {
    process.stderr.write(`${NAME}: cannot listen on ${host}:${wanted} — ${e.message}\n`);
    process.exit(1);
  }

  onShutdown((done) => {
    listener.close(done);
    // `close()` waits for every open connection, and a keep-alive one sitting
    // idle is open indefinitely. The client holding it is not going to send
    // anything else, so it does not get to hold the shutdown open either.
    if (typeof listener.closeIdleConnections === "function") listener.closeIdleConnections();
  });

  // stderr here too. stdout is the protocol under the other transport, and a
  // server that logs to a different stream depending on how it was started is
  // a server whose logs end up in the wrong place.
  const bound = listener.address();
  process.stderr.write(
    `${ctx.banner}\n${NAME} listening on http://${host}:${bound.port}${httpTransport.MCP_PATH} ` +
    `(health: http://${host}:${bound.port}${httpTransport.HEALTH_PATH})\n`
  );
}

/**
 * Leave on SIGTERM or SIGINT, giving `close` a moment to finish what is in
 * flight first.
 *
 * This is not optional in a container. The kernel ignores a signal's default
 * disposition for PID 1, and node installs a handler only where a listener
 * exists, so without this `docker stop` sends a SIGTERM into a process that
 * ignores it, waits out the whole grace period, and then SIGKILLs — costing ten
 * seconds on every redeploy and truncating an in-flight response instead of
 * finishing it.
 *
 * Both transports get it. Being PID 1 is a property of how the process was
 * started, not of which transport it chose, and stdio's existing exit path
 * covers only the client closing the pipe.
 */
function onShutdown(close) {
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`${NAME}: ${signal} — shutting down\n`);
    // Unreferenced, so a shutdown that finishes early is not held open by its
    // own deadline; it still fires if something in flight refuses to end.
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    close(() => process.exit(0));
  };
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop(signal));
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${NAME}: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { load, main, parseArgs };
