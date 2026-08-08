#!/usr/bin/env node
"use strict";

/**
 * dpc-mcp-server — serves the DPC Zettelkasten to MCP clients.
 *
 * Loads the collection, builds the GraphQL engine over it, and speaks MCP on
 * stdio. Nothing is written and nothing is fetched at request time; the graph
 * is read once at startup.
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

const ROOT = path.join(__dirname, "..");
const NAME = "dpc-mcp-server";
const VERSION = require(path.join(ROOT, "package.json")).version;

const RESOURCE_SCHEME = "dpc-zettelkasten";

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
    const { createEngine } = require(path.resolve(c.engine));
    return { engine: createEngine(dataset), origin: c.why, dataset: c.dataset };
  }
  throw new Error(
    "No zettelkasten data found. Tried:\n  " + tried.join("\n  ") +
    "\n\nRun `npm run sync` to fetch it, or set DPC_ZK_PATH to a " +
    "dpc-zettelkasten checkout."
  );
}

function main() {
  let loaded;
  try {
    loaded = load();
  } catch (e) {
    // stderr, never stdout — stdout carries the protocol and a stray line there
    // desynchronises the client.
    process.stderr.write(`${NAME}: ${e.message}\n`);
    process.exit(1);
  }

  const { engine, origin } = loaded;
  const tools = build(engine);
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
  server.listen(process.stdin, process.stdout);

  process.stderr.write(
    `${NAME} ${VERSION} ready — ${meta.noteCount} notes, ${meta.citationCount} citations ` +
    `across ${meta.repos.length} repositories (${origin})\n`
  );

  process.stdin.on("end", () => process.exit(0));
}

if (require.main === module) main();

module.exports = { load, main };
