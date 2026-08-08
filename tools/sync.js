#!/usr/bin/env node
"use strict";

/**
 * Refresh the vendored copy of the zettelkasten.
 *
 * The graph and the engine are vendored rather than fetched at request time so
 * the server starts with no network and always serves a known snapshot. The
 * cost is that it goes stale, which is what this script is for.
 *
 *   npm run sync                          # latest commit on the collection's main
 *   npm run sync -- --ref <sha>           # a specific commit
 *   npm run sync -- --from ../dpc-zettelkasten
 *   npm run sync -- --check               # report whether the snapshot is behind
 *
 * Syncing resolves a branch to a commit SHA first and then fetches files at
 * that SHA, recording it in vendor/SOURCE.json. Two reasons, and the second is
 * the one that bites:
 *
 *   1. You can tell exactly which version of the collection is being served.
 *   2. raw.githubusercontent.com caches branch paths. Fetching `main` can hand
 *      you a copy minutes old — which it did, once, and the vendored snapshot
 *      was silently a commit behind while `--check` reported it current.
 *      Paths under a commit SHA are immutable and cache correctly.
 *
 * This is the same rule the collection applies to its own citations, for the
 * same reason: a branch is not a version.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor");
const REPO = "Dans-Plugins/dpc-zettelkasten";
const BRANCH = "main";
const FILES = [
  { remote: "site/dataset.json", local: "dataset.json" },
  { remote: "lib/zk-graphql.js", local: "zk-graphql.js" },
];
const SOURCE_FILE = path.join(VENDOR, "SOURCE.json");

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = { headers: Object.assign({ "User-Agent": "dpc-mcp-server-sync" }, headers || {}) };
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, headers));
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

/** Resolve a branch to the commit it points at, via the API rather than the CDN. */
async function resolveRef(ref) {
  const body = await get(`https://api.github.com/repos/${REPO}/commits/${ref}`, {
    Accept: "application/vnd.github+json",
  });
  const sha = JSON.parse(body).sha;
  if (!/^[0-9a-f]{40}$/.test(sha || "")) throw new Error(`could not resolve ${ref} to a commit`);
  return sha;
}

async function fetchAt(sha) {
  const out = {};
  for (const f of FILES) {
    out[f.local] = await get(`https://raw.githubusercontent.com/${REPO}/${sha}/${f.remote}`);
  }
  return out;
}

function readLocal(from) {
  const out = {};
  for (const f of FILES) out[f.local] = fs.readFileSync(path.join(from, f.remote), "utf8");
  return out;
}

/**
 * Refuse to vendor a snapshot that does not work. Loads the fetched engine
 * against the fetched data so a broken sync fails here rather than the next
 * time the server starts.
 */
function verify(files) {
  const dataset = JSON.parse(files["dataset.json"]);
  if (!dataset.notes || !dataset.meta) throw new Error("dataset.json is missing notes or meta");
  const count = Object.keys(dataset.notes).length;
  if (!count) throw new Error("dataset.json contains no notes");

  fs.mkdirSync(VENDOR, { recursive: true });
  const tmp = path.join(VENDOR, ".zk-graphql.check.js");
  fs.writeFileSync(tmp, files["zk-graphql.js"]);
  try {
    const { createEngine } = require(tmp);
    const engine = createEngine(dataset);
    if (!engine.notes || !engine.meta) {
      throw new Error("engine does not expose notes and meta — the server needs both");
    }
    const { data, notes } = engine.execute("{ stats { noteCount citationCount } notes(first: 2) { title } }");
    if (data.stats.noteCount !== dataset.meta.noteCount) {
      throw new Error("engine and dataset disagree about the note count");
    }
    if (!notes.length) throw new Error("engine tracked no notes while executing");
    if (!engine.sdl().includes("type Note")) throw new Error("schema is missing the Note type");
    return { count, stats: data.stats };
  } finally {
    delete require.cache[require.resolve(tmp)];
    fs.unlinkSync(tmp);
  }
}

function currentSource() {
  if (!fs.existsSync(SOURCE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8")); } catch (e) { return null; }
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const at = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; };
  const from = at("--from");
  const wantRef = at("--ref") || BRANCH;

  if (from && !fs.existsSync(path.join(from, "site/dataset.json"))) {
    console.error(`error: ${from} does not look like a dpc-zettelkasten checkout`);
    console.error("hint: run `python3 tools/build.py` there first — dataset.json is generated");
    process.exit(1);
  }

  /* ---------------------------------------------------------- --check */
  if (check) {
    const source = currentSource();
    if (!source) {
      console.error("no vendor/SOURCE.json — the snapshot predates ref pinning; run `npm run sync`");
      process.exit(1);
    }
    let head;
    try {
      head = await resolveRef(BRANCH);
    } catch (e) {
      console.error(`could not reach GitHub: ${e.message}`);
      process.exit(2);
    }
    if (source.ref === head) {
      console.log(`up to date — pinned at ${head.slice(0, 10)} (${source.noteCount} notes)`);
      process.exit(0);
    }
    console.error(
      `out of date — vendored ${source.ref.slice(0, 10)}, ${BRANCH} is now ${head.slice(0, 10)}\n` +
      `  https://github.com/${REPO}/compare/${source.ref}...${head}\n` +
      "  run `npm run sync` to refresh"
    );
    process.exit(1);
  }

  /* ----------------------------------------------------------- sync */
  let files, ref, origin;
  try {
    if (from) {
      files = readLocal(from);
      ref = null;
      origin = path.resolve(from);
    } else {
      ref = /^[0-9a-f]{40}$/.test(wantRef) ? wantRef : await resolveRef(wantRef);
      files = await fetchAt(ref);
      origin = `https://github.com/${REPO}`;
    }
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

  fs.mkdirSync(VENDOR, { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(VENDOR, f.local), files[f.local]);
  fs.writeFileSync(SOURCE_FILE, JSON.stringify({
    repo: REPO,
    ref,
    origin,
    noteCount: info.count,
    citationCount: info.stats.citationCount,
    files: FILES.map((f) => f.remote),
  }, null, 2) + "\n");

  console.log(
    `synced ${info.count} notes, ${info.stats.citationCount} citations from ${origin}` +
    (ref ? ` @ ${ref.slice(0, 10)}` : " (local checkout, unpinned)")
  );
}

main();
