# Tools

The reference for everything this server exposes. DPC convention asks for a
`COMMANDS.md`; this server has no commands, so the tool list takes its place.

Every tool returns a single text block. Except where noted that block is JSON.

---

## `search_notes`

Full-text search. The place to start when you have a topic rather than a note id.

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `query` | string | yes | Words to look for in titles, summaries, tags, and bodies. |
| `type` | `concept` \| `moc` | no | Restrict to concept notes or Maps of Content. |
| `limit` | integer 1–50 | no | Maximum results. Default 10. |

Results are ranked by *where* the match landed — a title hit outweighs a
summary hit, which outweighs a body hit. A note that merely mentions a term
should not outrank the note that is about it.

```json
{
  "query": "power",
  "matched": 12,
  "returned": 10,
  "results": [
    { "id": "faction-power", "title": "Faction Power", "type": "concept",
      "moc": "moc-faction-domain-model", "summary": "…",
      "linkCount": 5, "backlinkCount": 11, "sourceCount": 2 }
  ],
  "hint": "2 further matches not shown; raise \"limit\" or narrow the query."
}
```

---

## `get_note`

One note in full.

| Argument | Type | Required |
|---|---|---|
| `id` | string | yes |

Returns the Markdown body, the note's links and backlinks, and every citation
with a permalink pinned to a commit SHA. An unknown id comes back as an error
with near-miss suggestions rather than an empty result.

```json
{
  "id": "demesne-limit",
  "title": "Demesne Limit",
  "moc": "moc-faction-domain-model",
  "links": ["claimed-chunk", "faction-power", "vassalage"],
  "backlinks": ["faction-power", "player-power", "…"],
  "sources": [
    { "repo": "Dans-Plugins/Medieval-Factions",
      "path": "src/main/kotlin/…/MfFactionClaimFillCommand.kt",
      "lines": "109-110",
      "ref": "3a51c55366b544d31429fae8bcb64efaf1878e15",
      "claim": "When factions.limitLand is enabled, a claim is refused if …",
      "url": "https://github.com/…/blob/3a51c55…/…#L109-L110" }
  ],
  "markdown": "A faction may hold one [[claimed-chunk]] per point of …",
  "file": "notes/concepts/demesne-limit.md"
}
```

---

## `list_maps`

The structure of the collection. Useful for orienting before searching, and for
answering "what does this cover?".

No arguments. Returns each Map of Content in the order the root map presents
them, with the concept notes that call it home. Every concept belongs to exactly
one map.

```json
{
  "root": "moc-dans-plugins-community",
  "maps": [
    { "id": "moc-faction-domain-model", "title": "Faction Domain Model",
      "summary": "…",
      "concepts": [{ "id": "approval-request", "title": "Approval Request" }] }
  ],
  "totals": { "notes": 45, "maps": 7, "concepts": 38, "citations": 90, "repositories": 9 }
}
```

---

## `get_citations`

The sources of truth themselves, filterable.

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | no | One note. Omit to search across all of them. |
| `repo` | string | no | Substring of the repository name, e.g. `Medieval-Factions`. |
| `path` | string | no | Substring of the cited file path. |

Use it to check whether a claim is supported, or to find every note grounded in
a particular file.

```json
{
  "count": 3,
  "citations": [
    { "note": "ponder", "noteTitle": "Ponder",
      "claim": "Ponder is a multi-project Gradle build with three modules…",
      "repo": "Dans-Plugins/Ponder", "path": "settings.gradle",
      "lines": null, "ref": "ff5276ae…", "url": "https://github.com/…" }
  ],
  "note": "A pinned ref means the claim is true of that commit. Code may have moved since…"
}
```

---

## `graphql`

Structural questions the other tools cannot answer: which notes are most
connected, what a cluster contains, which repositories ground the most claims.

| Argument | Type | Required |
|---|---|---|
| `query` | string | yes |

```graphql
{
  notes(orderBy: degree, first: 5) {
    title
    degree
    moc { title }
  }
}
```

Returns `{ data, notesTouched }` — `notesTouched` being every note id the query
walked, which is often more useful than the shaped data when you want to know
what a cluster actually contains.

Read-only. Mutations, fragments, and variables are refused with an explanation.
A failed query returns the schema alongside the error, so the usual cause — a
guessed field name — is fixable without another round trip.

### Schema

```graphql
enum NoteType { concept moc }
enum NoteOrder { title degree citations }

type Query {
  notes(type: NoteType, moc: ID, tag: String, repo: String, search: String,
        linkedTo: ID, orderBy: NoteOrder, first: Int): [Note!]!
  note(id: ID!): Note
  mocs: [Note!]!
  concepts(first: Int): [Note!]!
  tags: [Tag!]!
  repositories: [Repository!]!
  stats: Stats
}

type Note {
  id: ID  title: String  type: NoteType  summary: String
  tags: [String!]!  updated: String  path: String  url: String
  moc: Note
  links(first: Int): [Note!]!
  backlinks(first: Int): [Note!]!
  neighbors(first: Int): [Note!]!
  linkCount: Int  backlinkCount: Int  degree: Int
  sources: [Source!]!  sourceCount: Int
  repositories: [String!]!
}

type Source { repo: String  path: String  ref: String  shortRef: String
              lines: String  claim: String  url: String }
type Tag { name: String  count: Int  notes: [Note!]! }
type Repository { name: String  url: String  citationCount: Int
                  noteCount: Int  pinnedRefs: [String!]!  notes: [Note!]! }
type Stats { noteCount: Int  mocCount: Int  conceptCount: Int
             citationCount: Int  linkCount: Int  repositoryCount: Int
             repositories: [String!]!  updated: String }
```

Call `get_schema` for the authoritative version — the one above is a copy and
this file is not generated.

### Worked queries

```graphql
# What is in one cluster
{ notes(moc: "moc-plugin-architecture") { title summary } }

# Two hops out from a note
{ note(id: "faction-power") { title links { title links { title } } } }

# Which repositories ground the collection
{ repositories { name citationCount noteCount pinnedRefs } }

# Notes grounded in a particular repository
{ notes(repo: "Ponder") { title sources { path claim } } }

# Everything tagged for persistence, most connected first
{ notes(tag: "persistence", orderBy: degree) { title degree } }
```

---

## `get_schema`

The GraphQL schema as SDL, as plain text rather than JSON. No arguments. Worth
calling before writing a non-trivial query.

---

## Resources

Every note is also an MCP resource:

```
dpc-zettelkasten://note/<id>
```

Reading one returns `text/markdown` — the note's body with frontmatter
reconstructed above it, citations included — so a client can attach a note to a
conversation without spending a tool call.
