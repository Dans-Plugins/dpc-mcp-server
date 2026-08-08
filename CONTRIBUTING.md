# Contributing

Thanks for your interest in dpc-mcp-server.

## Links

- [Website](https://dansplugins.com)
- [Discord](https://discord.gg/xXtuAQ2)
- [DPC Conventions](https://github.com/Dans-Plugins/dpc-conventions)
- [The collection this serves](https://github.com/Dans-Plugins/dpc-zettelkasten)

## Requirements

- A GitHub account and Git
- Node 18 or later

## Getting started

```bash
git clone https://github.com/<your-username>/dpc-mcp-server.git
cd dpc-mcp-server
npm install      # dev dependencies only — the server itself has none
npm test
```

## Two rules

**The server has no runtime dependencies.** Not a stylistic preference: the
collection's whole claim is that it can be checked without trusting anything,
and a server with no supply chain is easier to trust than one with ninety
transitive packages. `@modelcontextprotocol/sdk` is a dev dependency used by the
tests to drive this server as a real client would — that is where it belongs.

**The GraphQL schema is not maintained here.** `vendor/zk-graphql.js` is a
vendored copy of
[`lib/zk-graphql.js`](https://github.com/Dans-Plugins/dpc-zettelkasten/blob/main/lib/zk-graphql.js)
in the zettelkasten. Schema changes go there and arrive here through
`npm run sync`. Editing the vendored copy directly will be silently reverted by
the next sync, and a schema maintained in two places drifts.

## Where things live

```
src/protocol.js   MCP over stdio — JSON-RPC 2.0, one message per line
src/tools.js      The tools and their descriptions
src/server.js     Loads the collection, wires tools and resources, runs
tools/sync.js     Refreshes vendor/ from the published collection
vendor/           The committed snapshot — generated, do not hand-edit
test/run.js       Data, raw protocol, and live-client tests
```

## Writing a tool

A tool is an entry in the array in `src/tools.js` with a `name`, a
`description`, an `inputSchema`, and a `handler`.

The description is the part that matters. It is the only documentation the model
gets, and it should say **when to reach for this tool rather than another one**
— not merely what it does. Compare "searches notes" with "start here when you
have a topic rather than a note id; follow up with `get_note`". The second one
gets called correctly.

Handlers return `text(value)` from `src/protocol.js`. On failure, return
`text(message, true)` so the model sees `isError` and can recover, rather than
throwing — an exception reaches the client as a protocol error, which is harder
for a model to act on. Reserve thrown errors for genuinely malformed calls.

Add tests for it in `test/run.js`, in the client-layer section, so it is
exercised through the real SDK.

## Testing

```bash
npm test
```

Three layers, all of which must pass:

- **Data** — the vendored snapshot is well-formed, every concept cites a
  Dans-Plugins repository at a 40-character SHA, every wikilink resolves.
- **Raw protocol** — malformed JSON, unknown methods, notifications that must
  not be answered, batches. Things a well-behaved client never does.
- **Live client** — a real session with `@modelcontextprotocol/sdk`. This
  server implements the protocol by hand, so this layer is the actual claim.

If you change `src/protocol.js`, the live-client layer is what proves you did
not break it. Do not skip it.

## Pull requests

One coherent change per PR. Say what you tested. CI runs the full suite on Node
18, 20, and 22, and checks that `vendor/` matches the published collection.
