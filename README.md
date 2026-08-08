# DPC MCP Server

An [MCP](https://modelcontextprotocol.io/) server for the
[DPC Zettelkasten](https://github.com/Dans-Plugins/dpc-zettelkasten) — the
knowledge base describing how the Dan's Plugins Community Minecraft plugins
work.

It gives a model two things it does not otherwise have: **structural queries**
over the collection, and **the citation behind every claim**. Ask it how faction
power works and the answer comes back with a GitHub permalink pinned to a commit
SHA, so the claim can be checked rather than trusted.

## Install

Requires Node 18 or later. **No runtime dependencies.**

```bash
git clone https://github.com/Dans-Plugins/dpc-mcp-server.git
cd dpc-mcp-server
npm run sync      # optional — a snapshot is already committed
```

There is nothing to build. `node src/server.js` is the whole thing.

### Claude Code

```bash
claude mcp add dpc --  node /absolute/path/to/dpc-mcp-server/src/server.js
```

### Claude Desktop, or any client using `mcpServers`

```json
{
  "mcpServers": {
    "dpc": {
      "command": "node",
      "args": ["/absolute/path/to/dpc-mcp-server/src/server.js"]
    }
  }
}
```

## Tools

| Tool | For |
|---|---|
| `search_notes` | Full-text search. Start here when you have a topic, not an id. |
| `get_note` | One note in full — Markdown, links, backlinks, and every citation. |
| `list_maps` | The hierarchy: each Map of Content and the concepts under it. |
| `get_citations` | Sources of truth, filterable by note, repository, or path. |
| `graphql` | Structural questions the other tools cannot answer. |
| `get_schema` | The GraphQL schema as SDL. |

Full reference: [TOOLS.md](TOOLS.md).

The collection is also exposed as **resources** at
`dpc-zettelkasten://note/<id>`, one per note, so a client can attach a note to a
conversation without spending a tool call.

### The GraphQL tool

```graphql
{
  notes(orderBy: degree, first: 5) {
    title
    degree
    moc { title }
  }
}
```

The schema travels in the tool's own description, so a model can write a correct
query without a round trip — and a failed query gets the schema back in the
error, which is usually enough to fix it on the next attempt. Read-only by
construction: mutations, fragments, and variables are refused with an
explanation rather than a parse error.

## Where the data comes from

The graph and the query engine are **vendored** — committed into `vendor/` — so
the server starts with no network and always serves a known snapshot. The cost
is that it goes stale, which is what `npm run sync` is for.

```bash
npm run sync                            # from the published collection
npm run sync -- --from ../dpc-zettelkasten   # from a local checkout
npm run sync -- --check                 # exit non-zero if the copy is stale
```

A sync that produces a broken snapshot is refused rather than written: the
script loads the fetched engine, runs a query against the fetched data, and
checks they agree before touching `vendor/`.

Override the source at runtime if you would rather point at a checkout:

| Variable | Effect |
|---|---|
| `DPC_ZK_PATH` | Path to a `dpc-zettelkasten` checkout; uses its `site/dataset.json` and `lib/zk-graphql.js` |
| `DPC_ZK_DATASET` | Path to a specific `dataset.json` |
| `DPC_ZK_ENGINE` | Path to a specific `zk-graphql.js` |

See [CONFIG.md](CONFIG.md).

## One schema, not two

`vendor/zk-graphql.js` is not a reimplementation. It is the same file the
zettelkasten's offline explorer inlines into its own page — the schema and
engine live in
[`lib/zk-graphql.js`](https://github.com/Dans-Plugins/dpc-zettelkasten/blob/main/lib/zk-graphql.js)
over there, and both consumers load it.

That is deliberate. A schema maintained in two places drifts, and a model given
a stale schema writes queries that fail for reasons it cannot see.

## No dependencies

The server implements MCP's stdio transport — JSON-RPC 2.0, one message per
line — directly, in about 180 lines. The official SDK is a **dev** dependency,
used by the test suite to drive this server as a real client would.

That is the claim worth testing, so the tests make it: 47 assertions across the
vendored data, the raw wire protocol, and a live session with
`@modelcontextprotocol/sdk`.

```bash
npm install   # dev dependencies, for the tests
npm test
```

## Support

- [Discord](https://discord.gg/xXtuAQ2)
- [Bug reports](https://github.com/Dans-Plugins/dpc-mcp-server/issues/new)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).
