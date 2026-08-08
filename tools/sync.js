#!/usr/bin/env node
"use strict";

/**
 * Refresh the vendored copy of the zettelkasten.
 *
 * The graph and the engine are vendored rather than fetched at request time so
 * the server starts with no network and always serves a known snapshot. The
 * cost is that it goes stale, which is what this script is for.
 *
 *   npm run sync                     # from the published collection on GitHub
 *   npm run sync -- --from ../dpc-zettelkasten
 *   npm run sync -- --check          # exit non-zero if the vendored copy differs
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor");
const RAW = "https://raw.githubusercontent.com/Dans-Plugins/dpc-zettelkasten/main";
const FILES = [
  { remote: "site/dataset.json", local: "dataset.json" },
  { remote: "lib/zk-graphql.js", local: "zk-graphql.js" },
];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "dpc-mcp-server-sync" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} returned HTTP ${res.statusCode}`));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

async function fetchAll(from) {
  const out = {};
  for (const f of FILES) {
    out[f.local] = from
      ? fs.readFileSync(path.join(from, f.remote), "utf8")
      : await get(`${RAW}/${f.remote}`);
  }
  return out;
}

function verify(files) {
  const dataset = JSON.parse(files["dataset.json"]);
  if (!dataset.notes || !dataset.meta) throw new Error("dataset.json is missing notes or meta");
  const count = Object.keys(dataset.notes).length;
  if (!count) throw new Error("dataset.json contains no notes");

  // Load the fetched engine from a temp file so a broken sync fails here rather
  // than the next time the server starts.
  const tmp = path.join(VENDOR, ".zk-graphql.check.js");
  fs.mkdirSync(VENDOR, { recursive: true });
  fs.writeFileSync(tmp, files["zk-graphql.js"]);
  try {
    const { createEngine } = require(tmp);
    const engine = createEngine(dataset);
    const { data } = engine.execute("{ stats { noteCount citationCount } }");
    if (data.stats.noteCount !== dataset.meta.noteCount) {
      throw new Error("engine and dataset disagree about the note count");
    }
    return { count, stats: data.stats, sdl: engine.sdl().length };
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const fromIdx = argv.indexOf("--from");
  const from = fromIdx !== -1 ? argv[fromIdx + 1] : null;

  if (from && !fs.existsSync(path.join(from, "site/dataset.json"))) {
    console.error(`error: ${from} does not look like a dpc-zettelkasten checkout`);
    process.exit(1);
  }

  let files;
  try {
    files = await fetchAll(from);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  let info;
  try {
    info = verify(files);
  } catch (e) {
    console.error(`error: refusing to vendor a broken snapshot — ${e.message}`);
    process.exit(1);
  }

  if (check) {
    let same = true;
    for (const f of FILES) {
      const local = path.join(VENDOR, f.local);
      const current = fs.existsSync(local) ? fs.readFileSync(local, "utf8") : null;
      if (current !== files[f.local]) {
        console.error(`out of date: vendor/${f.local}`);
        same = false;
      }
    }
    if (same) console.log("vendored copy matches the published collection");
    process.exit(same ? 0 : 1);
  }

  fs.mkdirSync(VENDOR, { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(VENDOR, f.local), files[f.local]);

  console.log(
    `synced ${info.count} notes, ${info.stats.citationCount} citations ` +
    `(${info.sdl} chars of schema) from ${from || RAW}`
  );
}

main();
