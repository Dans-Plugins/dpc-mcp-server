"use strict";

/**
 * The tools this server exposes, and the reasoning behind the set.
 *
 * `graphql` is the powerful one, but a model that has never seen the schema
 * cannot write a good query on its first try — so the schema travels in the
 * tool description, and `search_notes` / `get_note` / `list_maps` cover the
 * three things a caller almost always wants without one.
 *
 * Every tool that returns a claim about the code also returns the citations
 * behind it. That is the whole reason to put this collection in front of a
 * model: an answer that arrives with a commit-pinned permalink can be checked,
 * and one that does not cannot.
 */

const { text, invalid } = require("./protocol.js");

const CITATION_NOTE =
  "Every claim in this collection is grounded in a file in a Dans-Plugins " +
  "repository, pinned at a commit SHA. When you use a note, cite its sources " +
  "rather than presenting the claim as your own knowledge — the permalinks are " +
  "what make the answer checkable.";

function build(engine) {
  const notes = engine.notes;
  const meta = engine.meta;
  const ids = Object.keys(notes);

  const brief = (n) => ({
    id: n.id,
    title: n.title,
    type: n.type,
    moc: n.moc || null,
    summary: n.summary,
    tags: n.tags,
    linkCount: n.links.length,
    backlinkCount: n.backlinks.length,
    sourceCount: n.sources.length,
  });

  const full = (n) => ({
    ...brief(n),
    updated: n.updated || null,
    links: n.links,
    backlinks: n.backlinks,
    sources: n.sources.map((s) => ({
      repo: s.repo,
      path: s.path,
      ref: s.ref,
      lines: s.lines || null,
      claim: s.claim,
      url: s.url,
    })),
    markdown: n.body,
    file: n.sourcePath,
    fileUrl: n.sourceUrl,
  });

  const tools = [
    {
      name: "search_notes",
      description:
        "Full-text search across the DPC Zettelkasten — a knowledge base describing how " +
        "the Dan's Plugins Community Minecraft plugins work (Medieval Factions and the " +
        "repositories around it). Start here when you have a topic rather than a note id. " +
        "Returns matching notes with summaries; follow up with get_note for the full text " +
        "and its citations. " + CITATION_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to look for in titles, summaries, and bodies." },
          type: { type: "string", enum: ["concept", "moc"], description: "Restrict to concept notes or Maps of Content." },
          limit: { type: "integer", description: "Maximum results (default 10).", minimum: 1, maximum: 50 },
        },
        required: ["query"],
      },
      handler: (a) => {
        if (typeof a.query !== "string" || !a.query.trim()) throw invalid("query must be a non-empty string");
        const q = a.query.toLowerCase();
        const terms = q.split(/\s+/).filter(Boolean);
        let hits = ids
          .map((id) => notes[id])
          .filter((n) => !a.type || n.type === a.type)
          .map((n) => {
            // Rank by where the match lands: a title hit means the note is
            // about the topic; a body hit only means it mentions it.
            let score = 0;
            for (const t of terms) {
              if (n.title.toLowerCase().includes(t)) score += 10;
              if ((n.summary || "").toLowerCase().includes(t)) score += 4;
              if ((n.tags || []).some((tag) => tag.includes(t))) score += 3;
              if (n.text.includes(t)) score += 1;
            }
            return { n, score };
          })
          .filter((r) => r.score > 0)
          .sort((x, y) => y.score - x.score || x.n.title.localeCompare(y.n.title));

        const limit = Math.min(Math.max(a.limit || 10, 1), 50);
        const shown = hits.slice(0, limit);
        return text({
          query: a.query,
          matched: hits.length,
          returned: shown.length,
          results: shown.map((r) => brief(r.n)),
          hint: hits.length > shown.length
            ? `${hits.length - shown.length} further matches not shown; raise "limit" or narrow the query.`
            : undefined,
        });
      },
    },

    {
      name: "get_note",
      description:
        "Fetch one note in full: its Markdown body, its links and backlinks, and every " +
        "citation with a commit-pinned GitHub permalink. Use this once search_notes or " +
        "list_maps has given you an id. " + CITATION_NOTE,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: 'Note id, e.g. "faction-power" or "moc-plugin-architecture".' },
        },
        required: ["id"],
      },
      handler: (a) => {
        const n = notes[a.id];
        if (!n) {
          const near = ids.filter((i) => i.includes(String(a.id || "").toLowerCase())).slice(0, 8);
          return text(
            `No note with id "${a.id}".` +
            (near.length ? ` Did you mean: ${near.join(", ")}?` : " Use search_notes to find one."),
            true
          );
        }
        return text(full(n));
      },
    },

    {
      name: "list_maps",
      description:
        "The structure of the collection: every Map of Content and the concept notes that " +
        "call it home. Use this to orient before searching, or to answer 'what does this " +
        "collection cover?'. Each concept note belongs to exactly one map.",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        const homed = {};
        for (const id of ids) {
          const n = notes[id];
          if (n.moc) (homed[n.moc] = homed[n.moc] || []).push(id);
        }
        const order = (meta.mocOrder || []).filter((m) => notes[m]);
        return text({
          root: meta.home,
          maps: order.map((m) => ({
            id: m,
            title: notes[m].title,
            summary: notes[m].summary,
            concepts: (homed[m] || []).sort().map((i) => ({ id: i, title: notes[i].title })),
          })),
          totals: {
            notes: meta.noteCount,
            maps: meta.mocCount,
            concepts: meta.conceptCount,
            citations: meta.citationCount,
            repositories: meta.repos.length,
          },
        });
      },
    },

    {
      name: "get_citations",
      description:
        "Every source of truth behind a note, or across the whole collection — repository, " +
        "file path, line range, the specific claim it supports, and a permalink pinned at a " +
        "commit SHA. Use this to check whether a claim is actually supported, or to find " +
        "which notes cite a given repository.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Note id. Omit to search across all notes." },
          repo: { type: "string", description: 'Filter by repository, e.g. "Medieval-Factions".' },
          path: { type: "string", description: "Filter by a substring of the cited file path." },
        },
      },
      handler: (a) => {
        let rows = [];
        const pool = a.id ? (notes[a.id] ? [notes[a.id]] : null) : ids.map((i) => notes[i]);
        if (pool === null) return text(`No note with id "${a.id}".`, true);
        for (const n of pool) {
          for (const s of n.sources) {
            if (a.repo && !s.repo.toLowerCase().includes(String(a.repo).toLowerCase())) continue;
            if (a.path && !s.path.toLowerCase().includes(String(a.path).toLowerCase())) continue;
            rows.push({
              note: n.id, noteTitle: n.title, claim: s.claim,
              repo: s.repo, path: s.path, lines: s.lines || null, ref: s.ref, url: s.url,
            });
          }
        }
        return text({
          count: rows.length,
          citations: rows,
          note: "A pinned ref means the claim is true of that commit. Code may have " +
                "moved since; the zettelkasten's own check_sources.py reports drift.",
        });
      },
    },

    {
      name: "graphql",
      description:
        "Run a GraphQL query against the collection's structure. Use this for questions " +
        "the other tools cannot answer — which notes are most connected, what a cluster " +
        "contains, which repositories ground the most claims, how two notes relate.\n\n" +
        "Read-only: no mutations, fragments, or variables. Inline argument values.\n\n" +
        "Examples:\n" +
        '  { notes(orderBy: degree, first: 5) { title degree moc { title } } }\n' +
        '  { notes(moc: "moc-faction-domain-model") { title summary } }\n' +
        '  { note(id: "demesne-limit") { title links { title } sources { claim url } } }\n' +
        '  { repositories { name citationCount noteCount } }\n\n' +
        "SCHEMA:\n" + engine.sdl(),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The GraphQL query document." },
        },
        required: ["query"],
      },
      handler: (a) => {
        if (typeof a.query !== "string" || !a.query.trim()) throw invalid("query must be a non-empty string");
        try {
          const { data, notes: touched } = engine.execute(a.query);
          return text({ data, notesTouched: touched });
        } catch (e) {
          // Hand the model the schema again — the usual cause is a guessed field.
          return text(
            `GraphQL error: ${e.message}\n\n` +
            `The query was:\n${a.query}\n\n` +
            `Schema:\n${engine.sdl()}`,
            true
          );
        }
      },
    },

    {
      name: "get_schema",
      description:
        "The GraphQL schema for the collection, as SDL. Call this before writing a " +
        "non-trivial query with the graphql tool.",
      inputSchema: { type: "object", properties: {} },
      handler: () => text(engine.sdl()),
    },
  ];

  const byName = {};
  for (const t of tools) byName[t.name] = t;

  return {
    listTools: () =>
      tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    callTool: async (name, args) => {
      const tool = byName[name];
      if (!tool) throw invalid(`Unknown tool: ${name}. Available: ${tools.map((t) => t.name).join(", ")}`);
      return tool.handler(args);
    },
    brief,
    full,
  };
}

module.exports = { build };
