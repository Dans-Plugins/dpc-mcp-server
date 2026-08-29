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

### Over HTTP

The same server also speaks MCP's **Streamable HTTP** transport, for the cases
where a subprocess is not an option — a container, or a client on another
machine:

```bash
node src/server.js --http --port 8080     # POST /mcp, health at /healthz
```

It binds `127.0.0.1` unless `--host` says otherwise, and it has **no
authentication of its own**, so it is a local and private-network transport
until it grows one. stdio remains the default and the right choice for a local
client.

```bash
claude mcp add --transport http dpc http://127.0.0.1:8080/mcp
```

### In a container

The `Dockerfile` builds the HTTP transport into an image. There is no
`npm install` in it and no `node_modules` in the result — copying `package.json`,
`src/`, and `vendor/` is the whole build, which is what having no runtime
dependencies buys. It runs as the base image's `node` user, binds `0.0.0.0`
inside the container because nothing outside the network namespace could
otherwise reach it, and carries a `HEALTHCHECK` that probes `/healthz` with
`node` rather than assuming a slim image ships `curl`.

```bash
docker build -t dpc-mcp-server .
docker run -d -p 8080:8080 --name dpc dpc-mcp-server
curl -s http://127.0.0.1:8080/healthz
docker stop dpc
```

`docker stop` returns in about a second: the server handles `SIGTERM`, stops
accepting, and finishes what is in flight rather than being killed ten seconds
later.

The image binds a public interface *inside* the container and still has no
authentication of its own, so publish it behind something that does — the
gateway, or anything else that terminates auth in front of it.

**A container does not refresh itself.** The image bakes in
`vendor/dataset.json`, so it serves whatever commit of the collection was
vendored when the image was built — deliberately, since that is how the server
already works and it keeps the container from depending on the network at boot.
Updating the served collection is `npm run sync`, a commit, and a redeploy. The
pinned commit comes back from `/healthz` and from `list_maps`, so a stale
deployment is visible rather than silent.

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
npm run sync                                  # latest commit on the collection's main
npm run sync -- --ref <sha>                   # a specific commit
npm run sync -- --from ../dpc-zettelkasten    # a local checkout
npm run sync -- --check                       # is the snapshot behind main?
```

Syncing resolves the branch to a **commit SHA** and fetches at that SHA,
recording it in `vendor/SOURCE.json`. The server then reports which commit it is
serving, both in its startup line and in `list_maps`, so a stale snapshot is
visible rather than silent.

That pinning is not decoration. `raw.githubusercontent.com` caches branch paths,
and an early version of this script fetched `main` and vendored a copy that was
a commit behind — while `--check` cheerfully reported it current. Paths under a
commit SHA are immutable and cache correctly. It is the same rule the collection
applies to its own citations, for the same reason: a branch is not a version.

A sync that produces a broken snapshot is refused rather than written. The
script loads the fetched engine against the fetched data, runs a query, and
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

The server implements MCP's transports — JSON-RPC 2.0 over newline-delimited
stdio, and Streamable HTTP over `node:http` — directly, rather than through the
SDK. The official SDK is a **dev** dependency, used by the test suite to drive
this server as a real client would.

That is the claim worth testing, so the tests make it: 86 assertions across the
vendored data, the raw wire protocol, and live sessions on both transports with
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
