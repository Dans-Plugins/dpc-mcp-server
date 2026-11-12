# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added
- **Usage reporting**, on by default: a `startup` event (tags `version`,
  `transport`) and one `tool-call` event per call to a tool the server defines
  (tags `version` and the tool's `name` — never its arguments), sent to
  https://trace.danielstephenson.dev. The server says so on stderr at every
  start, never stdout. Off with `TRACE_USAGE_REPORTING=off`, `DO_NOT_TRACK=1`,
  or `"enabled": false` in `src/usage-reporting.json`. The client is
  trace-client-js, vendored in `vendor/` at a pinned commit, with the CommonJS
  copy derived by `npm run sync:trace-client` — still no runtime dependencies.
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
- Graceful shutdown on `SIGTERM` and `SIGINT`, on both transports. The kernel
  ignores a signal's default disposition for PID 1 and node installs a handler
  only where a listener exists, so a container previously waited out the whole
  `docker stop` grace period and then SIGKILLed. The HTTP transport now stops
  accepting and drains what is in flight, with a two-second deadline so a wedged
  socket cannot turn a fast stop into a hang. CI runs `docker stop` on the
  container it built and checks that it returns in under five seconds with exit
  code 0, so the container path is covered and not only the process one.
- Tests for the new transport, including a live session driven through the
  SDK's `StreamableHTTPClientTransport`. With those, the usage-reporting tests
  and the engine checks noted under Changed, the suite runs 170 checks, up from
  55 — 171 on Node 22.13 or later,
  where it also checks that `vendor/trace-client.js` is exactly what its
  TypeScript source derives to.

### Changed
- The vendored collection is `Dans-Plugins/dpc-zettelkasten@e6cd27828e`, up
  from `7c9b5f4eaa`: 55 notes and 144 citations across 14 repositories, up from
  45, 90 and 9. The engine, `zk-graphql.js`, now looks up notes, fields and
  arguments by own property only, so a `graphql` query naming `constructor` or
  `__proto__` gets an unknown-field or unknown-argument error, or a `null` note,
  rather than something every plain object inherits. Five client-layer checks
  hold it there.
- The vendored trace client is trace-client-js 0.4.0 (tag `0.4.0`, commit
  1b4d0fb), refreshed with `npm run sync:trace-client -- --ref <sha>`. Every
  event now carries a random installation ID as the tag `install`, so trace can
  count installations rather than events: `TRACE_INSTALL_ID` when set,
  otherwise a UUID the client keeps in `<user data dir>/dpc-mcp-server/trace-install-id`
  (`$XDG_DATA_HOME` or `~/.local/share` on Linux, `~/Library/Application Support`
  on macOS, `%APPDATA%` on Windows). The client reads or creates the file only
  when reporting is on. On Node before 20.16 / 22.3 the client cannot reach
  `node:fs`, and the ID lasts for the run only.
- The vendored trace client is trace-client-js 0.3.0 (commit 67cc4fc), which
  takes the program version at construction and tags every event with it.
  `src/usage.js` now passes the server's version to the constructor (falling
  back to `"unknown"` if blank) instead of adding the `version` tag to each
  event by hand; what is sent is unchanged.
- The vendored trace client is trace-client-js 0.2.0 (tag `0.2.0`, commit
  69b494b), refreshed with `npm run sync:trace-client -- --ref 0.2.0`; it checks
  `TRACE_USAGE_REPORTING` / `DO_NOT_TRACK` itself and exposes `disabledReason`.
  `src/usage.js` now uses the client's `TraceClient.environmentOptsOut` for that
  check instead of its own copy, and hands the client the environment it
  decided on, so the client never reads `process.env` behind it. The switches,
  their order and the reasons in the startup notice are unchanged.
- `Server.respond()` in `src/protocol.js` now owns batch handling, so both
  transports frame the same answers rather than each deciding what a batch
  means.
- `search_notes`'s `query` argument now says it matches tags as well as
  titles, summaries, and bodies, which is what the handler has always done.

### Fixed
- `search_notes` no longer drops `que` from a query as a stopword. The list is
  English filler; `que` was a stray, and in any query with other words beside
  it, it stopped `que` from matching `query` or `unique`. An unreachable
  Cyrillic entry, which the ASCII-only tokenizer could never produce, is gone
  as well.
- `get_note`, `get_citations`, and `resources/read` now answer an id like
  `constructor` or `__proto__` as the unknown id it is. Those names exist on
  any plain object by inheritance, so the lookup found them and the call failed
  as an internal protocol error with no way to recover. A resource uri whose
  percent-escape does not decode gets the same unknown-id answer, and
  `tools/call` answers a tool named `constructor` as an unknown tool.
- Malformed arguments now get an answer a model can act on. A `get_note` call
  with a missing or blank `id` is a `-32602` error, where a missing one used to
  offer the first eight ids as near misses of nothing. A `search_notes` `type` outside the
  enum is a `-32602` error rather than an empty result, and a `limit` that is
  not a number means the default rather than returning nothing with every match
  reported as hidden. `get_citations` gives the same recovery hint as `get_note`
  for an unknown id, and a non-string `uri` to `resources/read` is a `-32602`
  error rather than an internal failure.
- A blank `--port` or `MCP_HTTP_PORT` is refused with exit status 2 rather than
  read as `0`. `--port "$PORT"` with `PORT` unset used to start the server on a
  random port, which a proxy expecting a fixed one could only discover later.
  `0x50` and `1e3` are refused too. `--port 0` and `MCP_HTTP_PORT=0` still ask
  the OS for a free port.
- Startup arguments that would have no effect are refused with exit status 2.
  `--port` or `--host` without `--http` or `MCP_HTTP_PORT` used to print the
  ready line and speak stdio with nothing bound, a blank `--host` fell back to
  the default address, and `--http=false` turned HTTP on.

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
