# dpc-mcp-server as a container, for the gateway.
#
# There is no build stage and no `npm install`, because there is nothing to
# install: the server has no runtime dependencies, so copying the source and the
# vendored collection is the whole build. The SDK is a dev dependency the tests
# drive this server with, and it must not reach the image.
#
# The image bakes in vendor/dataset.json, so a running container serves whatever
# commit of the collection was vendored when the image was built. That is
# intended — it is how the server already works, and it keeps the container from
# depending on the network at boot — but it means refreshing the served
# collection is `npm run sync`, a commit, and a redeploy, not a background
# fetch. The pinned commit is reported at /healthz and by `list_maps`, so a
# stale deployment is visible rather than silent.

FROM node:22-slim

LABEL org.opencontainers.image.title="dpc-mcp-server"
LABEL org.opencontainers.image.description="MCP server for the DPC Zettelkasten"
LABEL org.opencontainers.image.source="https://github.com/Dans-Plugins/dpc-mcp-server"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# package.json is not optional: src/server.js reads the version it reports from
# it. tools/ and test/ are left out — sync is a maintenance task run in a
# checkout, and it is the one thing here that touches the network.
COPY package.json LICENSE ./
COPY src/ ./src/
COPY vendor/ ./vendor/

# Loopback is the right default for a process on a laptop and the wrong one for
# a process in a container, where nothing outside the network namespace could
# reach it. The container boundary is the boundary this transport relies on, and
# the gateway in front of it is what authenticates.
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=8080

EXPOSE 8080

# The base image ships a `node` user at uid 1000. Nothing is written at runtime
# and the graph is read once at startup, so it needs no ownership of anything.
USER node

# curl and wget are not in this base image, and assuming one of them is there is
# how a healthcheck ends up silently never running. node is the one interpreter
# the image is guaranteed to have. The port is read back from the environment so
# that overriding MCP_HTTP_PORT does not leave the probe checking the old one.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:' + (process.env.MCP_HTTP_PORT || 8080) + '/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

CMD ["node", "src/server.js", "--http"]
