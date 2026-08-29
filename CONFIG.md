# Configuration

There is no config file. Everything is environment variables and a handful of
flags for choosing a transport, and all of them are optional — `node
src/server.js` with nothing set serves the vendored collection on stdio.

## Where the collection is loaded from

Checked in this order; the first that exists wins.

| Variable | Meaning |
|---|---|
| `DPC_ZK_DATASET` | Path to a `dataset.json`. Pair with `DPC_ZK_ENGINE` if the matching engine is elsewhere. |
| `DPC_ZK_ENGINE` | Path to a `zk-graphql.js`. Defaults to the vendored copy. |
| `DPC_ZK_PATH` | Path to a `dpc-zettelkasten` checkout. Uses its `site/dataset.json` and `lib/zk-graphql.js`. |
| *(none)* | `vendor/dataset.json` and `vendor/zk-graphql.js` — the committed snapshot. |

The server reports which source it used, and which commit of the collection it
is serving, on stderr at startup:

```
dpc-mcp-server 0.1.0 ready — 45 notes, 90 citations across 9 repositories (vendored copy @ 7c9b5f4eaa)
```

Under `--http` a second line follows it, naming the address it bound and the
health endpoint beside it:

```
dpc-mcp-server listening on http://127.0.0.1:8080/mcp (health: http://127.0.0.1:8080/healthz)
```

The same information comes back from the `list_maps` tool under `collection`,
so a caller can tell whether an answer came from a current snapshot without
reading the server's log. `vendor/SOURCE.json` records it on disk.

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

## Which transport it speaks

stdio by default. `--http`, or setting `MCP_HTTP_PORT`, selects Streamable HTTP
instead: `POST /mcp` for the protocol, `GET /healthz` for a probe. `GET /mcp`
answers 405, because this server never initiates a message and so has no stream
to open.

| Flag | Variable | Default | Meaning |
|---|---|---|---|
| `--http` | `MCP_HTTP_PORT` (any value) | off | Serve HTTP instead of stdio. |
| `--port <n>` | `MCP_HTTP_PORT` | `8080` | Port to listen on. `0` asks the OS for a free one. |
| `--host <addr>` | `MCP_HTTP_HOST` | `127.0.0.1` | Address to bind. |
| — | `MCP_HTTP_ORIGINS` | *(none)* | Comma-separated `Origin` values to accept, or `*` for any. |

A flag beats the matching variable. `--help` prints the same summary.

The bind address is loopback unless you change it, and that is deliberate: this
transport has **no authentication of its own**, so putting it on a public
interface is a decision to be made explicitly rather than a side effect of
naming a port. Behind the gateway that means `--host 0.0.0.0` inside a
container, with the proxy in front doing the authenticating.

The `Dockerfile` is the one place where that decision has already been made:
the image sets `MCP_HTTP_HOST=0.0.0.0` and `MCP_HTTP_PORT=8080`, because the
container's network namespace is the boundary being relied on there. Both are
still environment variables, so `docker run -e MCP_HTTP_PORT=9000` moves the
port and the image's healthcheck follows it.

`MCP_HTTP_ORIGINS` is the DNS-rebinding defence the MCP specification asks for.
Requests carrying no `Origin` header are allowed — a client reading a config
file sends none — and requests from a loopback origin are always allowed.
Anything else has to be named, or it is refused with 403.

It is a gate, not CORS. No `Access-Control-Allow-Origin` is sent and preflight
`OPTIONS` is answered with 405, so naming an origin here does not make the
server reachable from a page in a browser — it only stops one that already
holds a connection from being refused. Browser clients are not supported.

Two more limits worth knowing: a request body over **64 KB** is refused with 413
rather than buffered, and an `MCP-Protocol-Version` header naming a version this
server does not speak is refused with 400 rather than answered in a dialect
neither side agreed to.

## Shutting down

`SIGTERM` and `SIGINT` both end the server with exit status 0, on either
transport. Under `--http` it stops accepting first and lets what is in flight
finish; a connection that has not finished within **two seconds** is abandoned,
so a wedged socket cannot turn a stop into a hang. On stdio the client closing
the pipe still ends the session, as it always did.

Handling the signal is what lets `docker stop` return as soon as the server
exits. The kernel ignores a signal's default disposition for PID 1, and node
installs a handler only where a listener exists, so a server that did not do
this would wait out the full ten-second grace period and then be killed
mid-response.

## Nothing is written, nothing is fetched

The graph is read once at startup and held in memory. No request touches the
network or the filesystem, and the server has no write path at all. Refreshing
the data means `npm run sync` (or rebuilding the checkout) and a restart.

## stdout is the protocol

Everything the server says to a human — the startup banner, load failures —
goes to **stderr**. A single stray line on stdout desynchronises the client, so
nothing else may write there. That holds under `--http` as well, where stdout
carries nothing at all: a server that logs to a different stream depending on
how it was started is a server whose logs end up in the wrong place.
