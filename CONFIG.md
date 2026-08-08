# Configuration

The server takes no command-line arguments and no config file. Everything is
environment variables, and all of them are optional.

## Where the collection is loaded from

Checked in this order; the first that exists wins.

| Variable | Meaning |
|---|---|
| `DPC_ZK_DATASET` | Path to a `dataset.json`. Pair with `DPC_ZK_ENGINE` if the matching engine is elsewhere. |
| `DPC_ZK_ENGINE` | Path to a `zk-graphql.js`. Defaults to the vendored copy. |
| `DPC_ZK_PATH` | Path to a `dpc-zettelkasten` checkout. Uses its `site/dataset.json` and `lib/zk-graphql.js`. |
| *(none)* | `vendor/dataset.json` and `vendor/zk-graphql.js` — the committed snapshot. |

The server reports which source it used on stderr at startup:

```
dpc-mcp-server 0.1.0 ready — 45 notes, 90 citations across 9 repositories (vendored copy)
```

### Working against a live checkout

Point the server at a checkout and it picks up every rebuild, which is what you
want while writing notes:

```json
{
  "mcpServers": {
    "dpc": {
      "command": "node",
      "args": ["/path/to/dpc-mcp-server/src/server.js"],
      "env": { "DPC_ZK_PATH": "/path/to/dpc-zettelkasten" }
    }
  }
}
```

Remember that the zettelkasten's `site/dataset.json` is a **generated** file —
run `python3 tools/build.py` there after editing notes, or the server will keep
serving the last build.

## Nothing is written, nothing is fetched

The graph is read once at startup and held in memory. No request touches the
network or the filesystem, and the server has no write path at all. Refreshing
the data means `npm run sync` (or rebuilding the checkout) and a restart.

## stdout is the protocol

Everything the server says to a human — the startup banner, load failures —
goes to **stderr**. A single stray line on stdout desynchronises the client, so
nothing else may write there.
