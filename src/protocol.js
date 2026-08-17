"use strict";

/**
 * Just enough of the Model Context Protocol to serve a read-only collection.
 *
 * MCP over stdio is JSON-RPC 2.0 with one message per line. Implementing that
 * directly keeps this server dependency-free, which matters more here than it
 * would elsewhere: the whole point of the collection is that it can be checked
 * without trusting anything, and a server with no supply chain is easier to
 * trust than one with ninety transitive packages. The official SDK is a dev
 * dependency instead, used by the tests to verify this implementation against
 * a real client.
 *
 * Implemented: initialize, notifications/initialized, ping, tools/list,
 * tools/call, resources/list, resources/read. Anything else answers with
 * JSON-RPC error -32601 rather than hanging the client.
 */

const PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

class Server {
  constructor(info, handlers) {
    this.info = info;
    this.handlers = handlers;
    this.initialized = false;
  }

  /** Handle one parsed message; returns a response object, or null for notifications. */
  async handle(msg) {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      return error(null, ERR.INVALID_REQUEST, "Request must be a JSON object");
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    if (typeof method !== "string") {
      return isNotification ? null : error(id, ERR.INVALID_REQUEST, "Missing method");
    }

    // Notifications never get a reply, even when we ignore them.
    if (method.startsWith("notifications/")) {
      if (method === "notifications/initialized") this.initialized = true;
      return null;
    }

    try {
      const result = await this.dispatch(method, params || {});
      if (result === undefined) {
        return isNotification ? null : error(id, ERR.METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
      return isNotification ? null : { jsonrpc: "2.0", id, result };
    } catch (e) {
      if (isNotification) return null;
      const code = e.code || ERR.INTERNAL;
      return error(id, code, e.message);
    }
  }

  async dispatch(method, params) {
    switch (method) {
      case "initialize": {
        // Echo the client's version when we speak it, so a newer client is not
        // forced down to ours; otherwise name the one we do speak.
        const asked = params.protocolVersion;
        return {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: this.info,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.handlers.listTools() };
      case "tools/call": {
        const { name, arguments: args } = params;
        if (!name) throw invalid("tools/call requires a tool name");
        return await this.handlers.callTool(name, args || {});
      }
      case "resources/list":
        return { resources: this.handlers.listResources() };
      case "resources/read": {
        const { uri } = params;
        if (!uri) throw invalid("resources/read requires a uri");
        return await this.handlers.readResource(uri);
      }
      case "prompts/list":
        return { prompts: [] };
      case "resources/templates/list":
        return { resourceTemplates: this.handlers.listResourceTemplates() };
      default:
        return undefined;
    }
  }

  /**
   * Handle one parsed message or a batch of them, and return what should be
   * sent back — a response object, an array of them, or null when everything
   * in the message was a notification. This is the whole transport-facing
   * surface: stdio frames the result with newlines, HTTP with a status code.
   */
  async respond(msg) {
    if (Array.isArray(msg)) {
      const out = [];
      for (const one of msg) {
        const r = await this.handle(one);
        if (r) out.push(r);
      }
      return out.length ? out : null;
    }
    return await this.handle(msg);
  }

  /** Read newline-delimited JSON-RPC from `input`, write replies to `output`. */
  listen(input, output) {
    let buffer = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.consume(line, output);
      }
    });
    return this;
  }

  async consume(line, output) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      write(output, error(null, ERR.PARSE, "Invalid JSON: " + e.message));
      return;
    }
    // A batch is a JSON array of requests; reply with an array of the responses
    // that are not notifications, or nothing if they all were.
    const response = await this.respond(msg);
    if (response) write(output, response);
  }
}

function write(output, obj) {
  output.write(JSON.stringify(obj) + "\n");
}

function error(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
}

function invalid(message) {
  const e = new Error(message);
  e.code = ERR.INVALID_PARAMS;
  return e;
}

/** Tool results are content blocks; `isError` tells the model the call failed. */
function text(value, isError) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const result = { content: [{ type: "text", text: body }] };
  if (isError) result.isError = true;
  return result;
}

module.exports = { Server, text, invalid, ERR, PROTOCOL_VERSION, SUPPORTED_VERSIONS };
