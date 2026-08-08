# Changelog

All notable changes to this project are documented here.

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
- 47 tests across the vendored data, the raw wire protocol, and a live session
  with `@modelcontextprotocol/sdk`.
