/**
 * The DPC Zettelkasten as a GraphQL schema.
 *
 * One implementation, two homes: the offline explorer inlines this file into
 * site/index.html, and dpc-mcp-server requires it directly. Keeping a single
 * copy is the point — a schema that drifts between the page and the MCP server
 * is worse than having only one of them.
 *
 * Supports the query subset the schema needs: named or anonymous queries,
 * nested selection sets, field arguments, and aliases. No mutations,
 * subscriptions, fragments, or variables — the graph is read-only.
 *
 *   const { createEngine } = require("./zk-graphql.js");
 *   const engine = createEngine({ notes, meta });
 *   engine.execute("{ stats { noteCount } }");   // -> { data, notes }
 *   engine.sdl();                                // -> schema text
 *
 * `notes` is an id-keyed map of note records and `meta` is the collection
 * summary; both are produced by tools/build.py.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ZKGraphQL = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createEngine(dataset) {
    const NOTES = dataset.notes;
    const META = dataset.meta;
    const ids = Object.keys(NOTES);

    const PUNCT = "{}()[]:,!$=@";

    function tokenize(src) {
      const out = [];
      let i = 0;
      while (i < src.length) {
        const c = src[i];
        if (/\s|,/.test(c)) { i++; continue; }
        if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
        if (c === "." && src.slice(i, i + 3) === "...") {
          throw err("Fragments are not supported", i);
        }
        if (PUNCT.includes(c)) { out.push({ k: c, v: c, at: i }); i++; continue; }
        if (c === '"') {
          let j = i + 1, v = "";
          while (j < src.length && src[j] !== '"') {
            if (src[j] === "\\") { v += src[j + 1]; j += 2; } else { v += src[j++]; }
          }
          if (j >= src.length) throw err("Unterminated string", i);
          out.push({ k: "String", v, at: i }); i = j + 1; continue;
        }
        if (/[-0-9]/.test(c)) {
          let j = i; if (src[j] === "-") j++;
          while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
          out.push({ k: "Number", v: Number(src.slice(i, j)), at: i }); i = j; continue;
        }
        if (/[_A-Za-z]/.test(c)) {
          let j = i;
          while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j++;
          out.push({ k: "Name", v: src.slice(i, j), at: i }); i = j; continue;
        }
        throw err(`Unexpected character ${JSON.stringify(c)}`, i);
      }
      out.push({ k: "EOF", v: null, at: src.length });
      return out;
    }

    function err(message, at) {
      const e = new Error(message);
      e.at = at;
      return e;
    }

    function parse(src) {
      const toks = tokenize(src);
      let p = 0;
      const peek = () => toks[p];
      const next = () => toks[p++];
      const expect = (k) => {
        const t = next();
        if (t.k !== k) throw err(`Expected ${k} but found ${t.v === null ? "end of query" : JSON.stringify(String(t.v))}`, t.at);
        return t;
      };

      function value() {
        const t = next();
        if (t.k === "Number" || t.k === "String") return t.v;
        if (t.k === "$") throw err("Variables are not supported; inline the value instead", t.at);
        if (t.k === "[") {
          const list = [];
          while (peek().k !== "]") list.push(value());
          next();
          return list;
        }
        if (t.k === "Name") {
          if (t.v === "true") return true;
          if (t.v === "false") return false;
          if (t.v === "null") return null;
          return t.v; // enum value
        }
        throw err(`Unexpected value ${JSON.stringify(String(t.v))}`, t.at);
      }

      function args() {
        const out = {};
        if (peek().k !== "(") return out;
        next();
        while (peek().k !== ")") {
          const name = expect("Name").v;
          expect(":");
          out[name] = value();
        }
        next();
        return out;
      }

      function selectionSet() {
        expect("{");
        const sels = [];
        while (peek().k !== "}") {
          if (peek().k === "EOF") throw err("Unclosed '{'", peek().at);
          let alias = null;
          let name = expect("Name").v;
          if (peek().k === ":") { next(); alias = name; name = expect("Name").v; }
          const a = args();
          const sub = peek().k === "{" ? selectionSet() : null;
          sels.push({ name, alias: alias || name, args: a, sel: sub, at: p });
        }
        next();
        if (!sels.length) throw err("Selection set is empty", peek().at);
        return sels;
      }

      if (peek().k === "Name" && (peek().v === "query" || peek().v === "mutation")) {
        const t = next();
        if (t.v === "mutation") throw err("This schema is read-only; only queries are supported", t.at);
        if (peek().k === "Name") next();               // operation name
        if (peek().k === "(") throw err("Variable definitions are not supported", peek().at);
      }
      const root = selectionSet();
      if (peek().k !== "EOF") throw err("Unexpected trailing input", peek().at);
      return root;
    }

    /* ------------------------------------------------------------ schema */

    const noteList = () => ids.map((id) => NOTES[id]);
    const resolveNote = (id) => NOTES[id] || null;

    function tagIndex() {
      const t = {};
      for (const id of ids) for (const tag of NOTES[id].tags || []) (t[tag] = t[tag] || []).push(id);
      return t;
    }
    function repoIndex() {
      const r = {};
      for (const id of ids) for (const s of NOTES[id].sources) {
        const e = (r[s.repo] = r[s.repo] || { name: s.repo, notes: new Set(), refs: new Set(), citations: 0 });
        e.notes.add(id); e.refs.add(s.ref); e.citations++;
      }
      return r;
    }

    function applyFilters(list, a) {
      let out = list;
      if (a.type) out = out.filter((n) => n.type === String(a.type));
      if (a.moc) out = out.filter((n) => n.moc === a.moc);
      if (a.tag) out = out.filter((n) => (n.tags || []).includes(a.tag));
      if (a.repo) out = out.filter((n) => n.sources.some((s) => s.repo === a.repo || s.repo.split("/")[1] === a.repo));
      if (a.search) {
        const q = String(a.search).toLowerCase();
        out = out.filter((n) => n.text.includes(q));
      }
      if (a.linkedTo) out = out.filter((n) => n.links.includes(a.linkedTo));
      out = out.slice().sort((x, y) => x.title.localeCompare(y.title));
      if (a.orderBy === "degree") {
        out = out.slice().sort((x, y) =>
          (y.links.length + y.backlinks.length) - (x.links.length + x.backlinks.length));
      }
      if (a.orderBy === "citations") {
        out = out.slice().sort((x, y) => y.sources.length - x.sources.length);
      }
      if (typeof a.first === "number") out = out.slice(0, a.first);
      return out;
    }

    const TYPES = {
      Query: {
        notes: { type: "Note", list: true,
          args: { type: "NoteType", moc: "ID", tag: "String", repo: "String", search: "String", linkedTo: "ID", orderBy: "NoteOrder", first: "Int" },
          resolve: (_, a) => applyFilters(noteList(), a) },
        note: { type: "Note", args: { id: "ID!" }, resolve: (_, a) => resolveNote(a.id) },
        mocs: { type: "Note", list: true, resolve: () => META.mocOrder.map(resolveNote).filter(Boolean) },
        concepts: { type: "Note", list: true, args: { first: "Int" },
          resolve: (_, a) => applyFilters(noteList().filter((n) => n.type === "concept"), a) },
        tags: { type: "Tag", list: true, resolve: () => {
          const t = tagIndex();
          return Object.keys(t).sort().map((name) => ({ name, ids: t[name] }));
        } },
        repositories: { type: "Repository", list: true, resolve: () => {
          const r = repoIndex();
          return Object.keys(r).sort().map((k) => r[k]);
        } },
        stats: { type: "Stats", resolve: () => META },
      },

      Note: {
        id: { type: "ID", resolve: (n) => n.id },
        title: { type: "String", resolve: (n) => n.title },
        type: { type: "NoteType", resolve: (n) => n.type },
        summary: { type: "String", resolve: (n) => n.summary },
        tags: { type: "String", list: true, resolve: (n) => n.tags || [] },
        updated: { type: "String", resolve: (n) => n.updated || null },
        path: { type: "String", resolve: (n) => n.sourcePath },
        url: { type: "String", resolve: (n) => n.sourceUrl },
        moc: { type: "Note", resolve: (n) => resolveNote(n.moc) },
        links: { type: "Note", list: true, args: { first: "Int" },
          resolve: (n, a) => cut(n.links.map(resolveNote).filter(Boolean), a) },
        backlinks: { type: "Note", list: true, args: { first: "Int" },
          resolve: (n, a) => cut(n.backlinks.map(resolveNote).filter(Boolean), a) },
        neighbors: { type: "Note", list: true, args: { first: "Int" },
          resolve: (n, a) => cut([...new Set(n.links.concat(n.backlinks))].map(resolveNote).filter(Boolean), a) },
        linkCount: { type: "Int", resolve: (n) => n.links.length },
        backlinkCount: { type: "Int", resolve: (n) => n.backlinks.length },
        degree: { type: "Int", resolve: (n) => n.links.length + n.backlinks.length },
        sources: { type: "Source", list: true, resolve: (n) => n.sources },
        sourceCount: { type: "Int", resolve: (n) => n.sources.length },
        repositories: { type: "String", list: true,
          resolve: (n) => [...new Set(n.sources.map((s) => s.repo))].sort() },
      },

      Source: {
        repo: { type: "String", resolve: (s) => s.repo },
        path: { type: "String", resolve: (s) => s.path },
        ref: { type: "String", resolve: (s) => s.ref },
        shortRef: { type: "String", resolve: (s) => s.shortRef },
        lines: { type: "String", resolve: (s) => s.lines || null },
        claim: { type: "String", resolve: (s) => s.claim },
        url: { type: "String", resolve: (s) => s.url },
      },

      Tag: {
        name: { type: "String", resolve: (t) => t.name },
        count: { type: "Int", resolve: (t) => t.ids.length },
        notes: { type: "Note", list: true, resolve: (t) => t.ids.map(resolveNote) },
      },

      Repository: {
        name: { type: "String", resolve: (r) => r.name },
        url: { type: "String", resolve: (r) => "https://github.com/" + r.name },
        citationCount: { type: "Int", resolve: (r) => r.citations },
        noteCount: { type: "Int", resolve: (r) => r.notes.size },
        pinnedRefs: { type: "String", list: true, resolve: (r) => [...r.refs].sort() },
        notes: { type: "Note", list: true, resolve: (r) => [...r.notes].sort().map(resolveNote) },
      },

      Stats: {
        noteCount: { type: "Int", resolve: (m) => m.noteCount },
        mocCount: { type: "Int", resolve: (m) => m.mocCount },
        conceptCount: { type: "Int", resolve: (m) => m.conceptCount },
        citationCount: { type: "Int", resolve: (m) => m.citationCount },
        linkCount: { type: "Int", resolve: (m) => m.linkCount },
        repositoryCount: { type: "Int", resolve: (m) => m.repos.length },
        repositories: { type: "String", list: true, resolve: (m) => m.repos },
        updated: { type: "String", resolve: (m) => m.updated },
      },
    };

    const SCALARS = new Set(["ID", "String", "Int", "Boolean", "NoteType", "NoteOrder"]);
    function cut(list, a) { return typeof a.first === "number" ? list.slice(0, a.first) : list; }

    /* ---------------------------------------------------------- execute */

    // Notes touched while resolving, in encounter order. Tracked during execution
    // rather than recovered from the JSON afterwards, so the result can be drawn
    // as a graph even when the query never selects an `id`.
    let touched = null;

    function execute(src) {
      const sels = parse(src);
      touched = [];
      const data = resolveSelections(sels, "Query", null);
      return { data, notes: [...new Set(touched)] };
    }

    function resolveSelections(sels, typeName, parent) {
      if (typeName === "Note" && parent && parent.id && touched) touched.push(parent.id);
      const fields = TYPES[typeName];
      const out = {};
      for (const sel of sels) {
        const def = fields[sel.name];
        if (!def) {
          throw err(`Cannot query field "${sel.name}" on type "${typeName}". ` +
                    `Available: ${Object.keys(fields).join(", ")}`, sel.at);
        }
        for (const key of Object.keys(sel.args)) {
          if (!def.args || !(key in def.args)) {
            throw err(`Unknown argument "${key}" on field "${sel.name}". ` +
                      `Accepts: ${def.args ? Object.keys(def.args).join(", ") : "none"}`, sel.at);
          }
        }
        if (def.args) {
          for (const [key, t] of Object.entries(def.args)) {
            if (t.endsWith("!") && !(key in sel.args)) {
              throw err(`Field "${sel.name}" requires argument "${key}"`, sel.at);
            }
          }
        }
        const value = def.resolve(parent, sel.args);
        const leaf = SCALARS.has(def.type);
        if (leaf) {
          if (sel.sel) throw err(`Field "${sel.name}" is a scalar and has no subfields`, sel.at);
          out[sel.alias] = value;
          continue;
        }
        if (!sel.sel) throw err(`Field "${sel.name}" of type "${def.type}" needs a selection set`, sel.at);
        if (value === null || value === undefined) { out[sel.alias] = null; continue; }
        out[sel.alias] = def.list
          ? value.map((v) => resolveSelections(sel.sel, def.type, v))
          : resolveSelections(sel.sel, def.type, value);
      }
      return out;
    }

    /* --------------------------------------------------------------- SDL */

    function sdl() {
      const lines = ["# The zettelkasten as a graph. Read-only — queries only.", ""];
      lines.push("enum NoteType { concept moc }");
      lines.push("enum NoteOrder { title degree citations }", "");
      for (const [name, fields] of Object.entries(TYPES)) {
        lines.push(`type ${name} {`);
        for (const [f, d] of Object.entries(fields)) {
          const a = d.args && Object.keys(d.args).length
            ? "(" + Object.entries(d.args).map(([k, v]) => `${k}: ${v}`).join(", ") + ")"
            : "";
          const t = d.list ? `[${d.type}!]!` : d.type;
          lines.push(`  ${f}${a}: ${t}`);
        }
        lines.push("}", "");
      }
      return lines.join("\n").trim();
    }

    return { execute, sdl, TYPES };

    return { execute, sdl, TYPES, notes: NOTES, meta: META };
  }

  return { createEngine };
});
