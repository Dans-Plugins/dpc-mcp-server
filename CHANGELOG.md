# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added
- A **Streamable HTTP** transport beside stdio, selected with `--http` or by
  setting `MCP_HTTP_PORT`. `POST /mcp` carries a JSON-RPC message or batch and
  answers with `application/json`; `GET /healthz` answers a probe without
  authentication; `GET /mcp` answers 405, because this server never initiates a
  message and so has no stream to open. Implemented over `node:http` — still no
  runtime dependencies.
- HTTP configuration: `--port` / `MCP_HTTP_PORT`, `--host` / `MCP_HTTP_HOST`,
  and `MCP_HTTP_ORIGINS` for the origin allowlist. The bind address defaults to
  loopback, because this transport has no authentication of its own yet.
- `--help`, describing both transports and the variables that configure them.
- A `Dockerfile` serving the HTTP transport, for deployment behind the gateway.
  No `npm install` and no `node_modules` in the image — copying `package.json`,
  `src/`, and `vendor/` is the whole build — running as the base image's `node`
  user, with a `HEALTHCHECK` that probes `/healthz` using `node`, the one
  interpreter a slim image is guaranteed to ship. CI builds the image and drives
  a session through it, so a broken Dockerfile fails here rather than on the box.
- Tests for the new transport, including a live session driven through the
  SDK's `StreamableHTTPClientTransport`: 83 assertions in total, up from 55.

### Changed
- `Server.respond()` in `src/protocol.js` now owns batch handling, so both
  transports frame the same answers rather than each deciding what a batch
  means.

## [0.1.0] - 2026-08-08

Initial release.

### Added
- MCP server over stdio with no runtime dependencies — JSON-RPC 2.0 implemented
  directly rather than through the SDK, which is a dev dependency used by the
  tests to drive this server as a real client would.
- Six tools: `search_notes`, `get_note`, `list_maps`, `get_citations`,
  `graphql`, `get_schema`. The GraphQL schema travels inside the `graphql`
  tool's description, and a failed query returns the schema so the caller can
  recover without a round trip.
- Every note exposed as a resource at `dpc-zettelkasten://note/<id>`, served as
  Markdown with its citations in the frontmatter.
- `npm run sync` refreshes the vendored graph and engine from the published
  collection or a local checkout, and refuses to write a snapshot whose engine
  and data disagree.
- `vendor/SOURCE.json` records the commit the snapshot came from, reported in
  the startup line and by `list_maps`. Syncing resolves a branch to a SHA and
  fetches at that SHA, because `raw.githubusercontent.com` caches branch paths
  and will otherwise hand back a copy that is silently a commit behind.
- 55 tests across the vendored data, the raw wire protocol, and a live session
  with `@modelcontextprotocol/sdk`.
