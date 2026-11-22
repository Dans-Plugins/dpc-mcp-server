#!/usr/bin/env node
"use strict";

/**
 * Records a real MCP session against this server and writes it out as an HTML
 * page for docs/screenshots/media.json to photograph.
 *
 * It drives `node src/server.js` over stdio with the official SDK client (the
 * same dev dependency the tests use), against the vendored snapshot, with usage
 * reporting off. Every line on the page is what the server actually returned;
 * a long response is cut at a fixed number of lines and the cut is marked.
 *
 *   npm install                       # the SDK is a dev dependency
 *   node docs/screenshots/session.js  # writes docs/screenshots/build/session.html
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(__dirname, "build", "session.html");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

/** The calls shown, in order, each with the section of the page it lands in. */
const CALLS = [
  { section: "hero", name: "get_citations", args: { id: "faction-power" }, maxLines: 40 },
  { section: "search", name: "search_notes", args: { query: "faction power", limit: 3 }, maxLines: 30 },
  { section: "graphql", name: "graphql",
    args: { query: "{ notes(orderBy: degree, first: 5) { title degree moc { title } } }" }, maxLines: 40 },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Colours pretty-printed JSON: keys, strings, numbers, literals. */
function highlight(line) {
  return esc(line)
    .replace(/^(\s*)(&quot;|")([^"]*)"(?=:)/, '$1<span class="k">"$3"</span>')
    .replace(/: "(.*)"(,?)$/, ': <span class="s">"$1"</span>$2')
    .replace(/^(\s*)"(.*)"(,?)$/, '$1<span class="s">"$2"</span>$3')
    .replace(/: (-?\d+(\.\d+)?)(,?)$/, ': <span class="n">$1</span>$3')
    .replace(/: (null|true|false)(,?)$/, ': <span class="l">$1</span>$2');
}

function block(textOut, maxLines) {
  let lines = textOut.split("\n");
  let cut = "";
  if (lines.length > maxLines) {
    cut = `<div class="cut">… ${lines.length - maxLines} more lines of this response</div>`;
    lines = lines.slice(0, maxLines);
  }
  return lines.map(highlight).join("\n") + (cut ? "\n" : "") + cut;
}

function call(name, args) {
  return `<div class="req"><span class="arrow">→</span> tools/call <b>${esc(name)}</b> ` +
    `<span class="args">${esc(JSON.stringify(args))}</span></div>`;
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "src", "server.js")],
    cwd: ROOT,
    env: Object.assign({}, process.env, { TRACE_USAGE_REPORTING: "off" }),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (d) => { stderr += d; });

  const client = new Client({ name: "docs-screenshots", version: "0" });
  await client.connect(transport);
  const info = client.getServerVersion();
  const { tools } = await client.listTools();

  const results = [];
  for (const c of CALLS) {
    const r = await client.callTool({ name: c.name, arguments: c.args });
    results.push({ ...c, text: r.content[0].text, isError: !!r.isError });
  }
  await client.close();

  const startup = stderr.trim().split("\n").filter(Boolean);
  const sections = {};
  for (const r of results) {
    sections[r.section] = (sections[r.section] || "") +
      call(r.name, r.args) + `<pre class="res${r.isError ? " err" : ""}">${block(r.text, r.maxLines)}</pre>`;
  }

  const toolList = tools.map((t) =>
    `<div class="tool"><b>${esc(t.name)}</b> <span class="dim">${esc(t.description.split(/(?<=\.)\s/)[0])}</span></div>`
  ).join("");

  const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>dpc-mcp-server session</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e;
          --k:#79c0ff; --s:#a5d6ff; --n:#ffa657; --l:#ff7b72; --ok:#3fb950; --acc:#d2a8ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.45 "DejaVu Sans Mono", ui-monospace, Menlo, Consolas, monospace; }
  section { width:1180px; margin:24px auto; background:var(--panel); border:1px solid var(--line);
            border-radius:10px; overflow:hidden; }
  .bar { padding:8px 14px; border-bottom:1px solid var(--line); color:var(--dim); font-size:12px;
         display:flex; gap:8px; align-items:center; }
  .dot { width:11px; height:11px; border-radius:50%; background:#30363d; display:inline-block; }
  .body { padding:14px 18px 16px; }
  .stderr { color:var(--dim); white-space:pre-wrap; margin:0 0 10px; }
  .stderr b { color:var(--ok); font-weight:normal; }
  .req { color:var(--fg); margin:12px 0 6px; }
  .req .arrow { color:var(--acc); }
  .req .args { color:var(--s); }
  pre.res { margin:0; padding:10px 14px; background:#0d1117; border:1px solid var(--line);
            border-radius:6px; white-space:pre-wrap; word-break:break-all; }
  .k { color:var(--k); } .s { color:var(--s); } .n { color:var(--n); } .l { color:var(--l); }
  .cut { color:var(--dim); font-style:italic; }
  .tool { margin:1px 0; } .tool b { color:var(--k); font-weight:normal; display:inline-block; width:130px; }
  .dim { color:var(--dim); }
</style></head><body>
<section id="hero">
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
    MCP client (stdio) ⇄ node src/server.js</div>
  <div class="body">
    <pre class="stderr">${startup.map((l, i) => i === 0 ? `<b>${esc(l)}</b>` : esc(l)).join("\n")}</pre>
    <div class="req"><span class="arrow">→</span> initialize <span class="dim">→ ${esc(info.name)} ${esc(info.version)}</span></div>
    <div class="req"><span class="arrow">→</span> tools/list <span class="dim">→ ${tools.length} tools</span></div>
    ${toolList}
    ${sections.hero}
  </div>
</section>
<section id="search">
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>search_notes</div>
  <div class="body">${sections.search}</div>
</section>
<section id="graphql">
  <div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>graphql</div>
  <div class="body">${sections.graphql}</div>
</section>
<script>
  // ?only=<section> shows one section at the top of the page, for cropping.
  const only = new URLSearchParams(location.search).get("only");
  if (only) for (const s of document.querySelectorAll("section")) s.hidden = s.id !== only;
</script>
</body></html>
`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, page);
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
