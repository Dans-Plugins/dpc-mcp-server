# Copilot instructions

This repository follows the DPC (Dans Plugins Community) conventions defined at
https://github.com/Dans-Plugins/dpc-conventions.

## What this is

An MCP (Model Context Protocol) server that serves the
[DPC Zettelkasten](https://github.com/Dans-Plugins/dpc-zettelkasten) — a
knowledge base about the DPC Minecraft plugins where every claim cites a file in
a Dans-Plugins repository, pinned at a commit SHA.

Node 18+, CommonJS, no build step.

## Two hard rules

**No runtime dependencies.** MCP's stdio transport is implemented directly in
`src/protocol.js` (JSON-RPC 2.0, newline-delimited). Do not add a runtime
dependency, including the official SDK — it is a dev dependency used by the
tests to drive this server as a real client would.

**The GraphQL schema is not maintained here.** `vendor/zk-graphql.js` and
`vendor/dataset.json` are generated copies from the zettelkasten, refreshed by
`npm run sync`. Schema changes belong in that repository's `lib/zk-graphql.js`.
Editing `vendor/` directly is reverted by the next sync.

## Layout

- `src/protocol.js` — the transport. Change with care; the live-client tests are
  what prove it still works.
- `src/tools.js` — tools, their descriptions, and their handlers.
- `src/server.js` — data loading, resources, wiring.
- `tools/sync.js` — refreshes `vendor/`, and refuses a snapshot whose engine and
  data disagree.
- `test/run.js` — data, raw-protocol, and live-client layers.

## Conventions that matter here

**stdout is the protocol.** Every human-facing message goes to stderr. A single
stray line on stdout desynchronises the client. Never `console.log` in `src/`.

**Tool descriptions say when to use the tool**, not just what it does. They are
the only documentation the model receives.

**Tool failures return `text(message, true)`**, not a thrown exception, so the
model sees `isError` and can recover. Throw only for malformed calls.

**Nothing is written and nothing is fetched at request time.** The graph is read
once at startup. The server has no write path; keep it that way.

## Testing

`npm test` must pass. It covers the vendored data, the raw wire protocol, and a
live session with `@modelcontextprotocol/sdk`. Changes to `src/protocol.js`
without a passing live-client layer are not acceptable.

## Branch and PR workflow

Branch from `main`. One coherent change per pull request.
