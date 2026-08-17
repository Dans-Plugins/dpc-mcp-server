"use strict";

/**
 * The Streamable HTTP transport (MCP revision 2025-03-26 and later).
 *
 * A second adapter over the same `Server.respond()` the stdio transport uses,
 * not a second protocol implementation: one POST carries one JSON-RPC message
 * or batch, and the reply comes straight back as `application/json`. Nothing
 * here is streamed, because this server never initiates a message — every
 * response it sends is an answer to a request, so the SSE half of the spec
 * would only ever carry silence. `GET /mcp` says so with a 405 rather than
 * leaving a client's stream attempt open.
 *
 * `node:http` only. The no-runtime-dependency rule applies here as everywhere
 * else, and an HTTP server is the last place to start trusting a supply chain.
 */

const http = require("http");

const { PROTOCOL_VERSION, SUPPORTED_VERSIONS, ERR } = require("./protocol.js");

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";
const DEFAULT_PORT = 8080;
/** Loopback by default: this transport has no authentication of its own yet. */
const DEFAULT_HOST = "127.0.0.1";
/** A generous ceiling for a query, and a small one for anything hostile. */
const MAX_BODY_BYTES = 64 * 1024;

/** Build the HTTP server around an already-wired protocol `Server`. */
function createServer(mcp, options) {
  const opts = options || {};
  const cfg = {
    allowedOrigins: opts.allowedOrigins || [],
    health: opts.health || (() => ({})),
    maxBodyBytes: opts.maxBodyBytes || MAX_BODY_BYTES,
  };
  return http.createServer((req, res) => {
    route(req, res, mcp, cfg).catch((e) => {
      if (res.headersSent) res.end();
      else sendError(res, 500, ERR.INTERNAL, e.message);
    });
  });
}

/**
 * Start listening. Resolves with the `http.Server` once the socket accepts, so
 * a caller can read the port the operating system actually assigned.
 */
function listen(mcp, options) {
  const opts = options || {};
  const port = opts.port === undefined ? DEFAULT_PORT : opts.port;
  const host = opts.host || DEFAULT_HOST;
  const server = createServer(mcp, opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function route(req, res, mcp, cfg) {
  const url = req.url.split("?")[0];

  if (url === HEALTH_PATH) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendError(res, 405, ERR.INVALID_REQUEST,
        `${req.method} is not allowed on ${HEALTH_PATH}; use GET.`, { allow: "GET, HEAD" });
    }
    // Deliberately not on /mcp: a health probe must never be mistaken for a
    // protocol message, and the probe runs before anything has authenticated.
    return sendJson(res, 200, Object.assign({ status: "ok" }, cfg.health()));
  }

  if (url !== MCP_PATH) {
    return sendError(res, 404, ERR.INVALID_REQUEST,
      `No such path: ${url}. MCP is served at ${MCP_PATH}; the healthcheck is at ${HEALTH_PATH}.`);
  }

  // The DNS-rebinding defence the spec asks for. An attacker's page keeps its
  // own Origin after rebinding a hostname to a loopback address, so refusing
  // an unexpected Origin is what stops it driving a locally-bound server.
  const origin = req.headers.origin;
  if (!originAllowed(origin, cfg.allowedOrigins)) {
    return sendError(res, 403, ERR.INVALID_REQUEST,
      `Origin ${origin} is not allowed. Set MCP_HTTP_ORIGINS to a comma-separated list ` +
      "of origins this server should accept.");
  }

  if (req.method !== "POST") {
    return sendError(res, 405, ERR.INVALID_REQUEST,
      `${req.method} is not allowed on ${MCP_PATH}. This server answers POST only; it never ` +
      "initiates a message, so there is no stream to open.", { allow: "POST" });
  }

  return await post(req, res, mcp, cfg);
}

async function post(req, res, mcp, cfg) {
  const contentType = String(req.headers["content-type"] || "");
  if (!/^application\/json\b/i.test(contentType.trim())) {
    return sendError(res, 415, ERR.INVALID_REQUEST,
      `Unsupported content type ${contentType ? `"${contentType}"` : "(none)"}; ` +
      "send a JSON-RPC message as application/json.");
  }

  const accept = String(req.headers["accept"] || "");
  if (accept && !/application\/json|\*\/\*/i.test(accept)) {
    return sendError(res, 406, ERR.INVALID_REQUEST,
      `Cannot produce ${accept}; every reply from this server is application/json.`);
  }

  // Honoured on every request after initialize, where the client states the
  // version it settled on. Answering 400 here is more useful than answering a
  // request in a dialect neither side agreed to.
  const asked = req.headers["mcp-protocol-version"];
  if (asked !== undefined && !SUPPORTED_VERSIONS.includes(String(asked))) {
    return sendError(res, 400, ERR.INVALID_REQUEST,
      `Unsupported MCP-Protocol-Version "${asked}". This server speaks ${SUPPORTED_VERSIONS.join(", ")}.`);
  }

  let body;
  try {
    body = await readBody(req, cfg.maxBodyBytes);
  } catch (e) {
    if (!e.tooLarge) throw e;
    return sendError(res, 413, ERR.INVALID_REQUEST, e.message, { connection: "close" });
  }

  let msg;
  try {
    msg = JSON.parse(body);
  } catch (e) {
    return sendError(res, 400, ERR.PARSE, "Invalid JSON: " + e.message);
  }

  const version = asked === undefined ? versionOf(msg) : String(asked);
  const reply = await mcp.respond(msg);

  if (!reply) {
    // Notifications carry no reply at all. The spec asks for 202 and an empty
    // body rather than a JSON-RPC envelope wrapped around nothing.
    res.writeHead(202, { "mcp-protocol-version": version });
    return res.end();
  }
  return sendJson(res, 200, reply, { "mcp-protocol-version": version });
}

/** Read the request body, refusing anything over `limit` rather than buffering it. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        req.pause();
        const e = new Error(`Request body exceeds the ${limit}-byte limit; a query does not need to be this large.`);
        e.tooLarge = true;
        reject(e);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

/** The version to echo when the client has not stated one: what initialize asked for. */
function versionOf(msg) {
  const one = Array.isArray(msg) ? msg.find((m) => m && m.method === "initialize") : msg;
  const asked = one && typeof one === "object" && one.method === "initialize" && one.params
    ? one.params.protocolVersion
    : null;
  return SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION;
}

/** Split a comma-separated origin allowlist, as `MCP_HTTP_ORIGINS` carries it. */
function parseOrigins(value) {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function originAllowed(origin, allowed) {
  // Only browsers send Origin, and it is browsers that rebinding attacks; an
  // MCP client speaking from a config file sends none.
  if (!origin) return true;
  if (allowed.includes("*")) return true;
  if (allowed.includes(origin)) return true;
  return isLoopbackOrigin(origin);
}

function isLoopbackOrigin(origin) {
  let host;
  try {
    host = new URL(origin).hostname;
  } catch (e) {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function sendJson(res, status, body, headers) {
  const payload = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  }, headers || {}));
  res.end(payload);
}

/**
 * Failures answer with a JSON-RPC error object as well as an HTTP status: the
 * status is for the proxy in front, the message is for the human or model
 * behind, and neither of them is helped by a stack trace.
 */
function sendError(res, status, code, message, headers) {
  sendJson(res, status, { jsonrpc: "2.0", id: null, error: { code, message } }, headers);
}

module.exports = {
  createServer,
  listen,
  parseOrigins,
  MCP_PATH,
  HEALTH_PATH,
  DEFAULT_PORT,
  DEFAULT_HOST,
  MAX_BODY_BYTES,
};
