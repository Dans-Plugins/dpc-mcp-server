"use strict";

/**
 * Usage reporting — that the server started, and which tools were called.
 *
 * Reports go to trace (https://trace.danielstephenson.dev) through the vendored
 * client in vendor/trace-client.js. What is sent is the program's name, its
 * version, the transport it was started on, and the NAME of each tool called.
 * Never a tool's arguments, never a note or a query, never anything about the
 * client or the person using it. Tool names are checked against the server's
 * own list first, so a name a client made up is not sent either.
 *
 * Every event also carries a random installation ID (tag `install`) so trace
 * can count installations rather than events: the value of TRACE_INSTALL_ID
 * when set, otherwise a UUID the client keeps in
 * <user data dir>/dpc-mcp-server/trace-install-id (see installIdFile below).
 *
 * On by default, and off with any one of these, checked in this order (the
 * first that applies is the reason given in the startup notice):
 *
 *   1. TRACE_USAGE_REPORTING=off (or false/0/no), or DO_NOT_TRACK=1 (or true/yes)
 *   2. "enabled": false in src/usage-reporting.json
 *   3. no key in src/usage-reporting.json
 *
 * The notice goes to stderr, never stdout: on stdio, stdout is the protocol,
 * and one stray line there desynchronises the client.
 */

const os = require("os");
const path = require("path");
const { TraceClient } = require("../vendor/trace-client.js");

const DETAILS = "https://github.com/Stephenson-Software/trace#usage-reporting";
const CONFIG_FILE = path.join(__dirname, "usage-reporting.json");
/** How long a stopping server waits for reports still in flight. */
const CLOSE_MS = 1000;

/**
 * Whether TRACE_USAGE_REPORTING or DO_NOT_TRACK in `env` turns reporting off.
 * The check is the vendored client's own, so the values it accepts are exactly
 * those of every other trace client.
 */
function environmentOptOut(env) {
  return TraceClient.environmentOptsOut(env);
}

/**
 * Decide whether to report, and why not if not. `config` is the parsed
 * usage-reporting.json; `env` is process.env or a test's stand-in.
 */
function settings(config, env) {
  const cfg = config || {};
  const key = typeof cfg.key === "string" ? cfg.key.trim() : "";
  let reason = null;
  if (environmentOptOut(env)) reason = "environment";
  else if (cfg.enabled === false) reason = "src/usage-reporting.json";
  else if (!key) reason = "no key";
  return {
    enabled: reason === null,
    reason,
    // USAGE_REPORTING_ENDPOINT points the reports somewhere else — a local
    // stub while testing, or a self-hosted trace.
    endpoint: (env.USAGE_REPORTING_ENDPOINT || cfg.endpoint || "https://trace.danielstephenson.dev").trim(),
    application: cfg.application || "dpc-mcp-server",
    key,
  };
}

/**
 * Where the client keeps the installation ID: `<user data dir>/<application>/trace-install-id`,
 * the user data dir being $XDG_DATA_HOME or ~/.local/share on Linux and the
 * BSDs, ~/Library/Application Support on macOS, and %APPDATA% on Windows.
 * Only a path: the client reads or creates the file, and only when reporting
 * is on, so an opt-out never creates it. Null when no home directory is known.
 */
function installIdFile(application, env, platform, home) {
  const plat = platform || process.platform;
  let base = "";
  if (plat === "win32") base = (env.APPDATA || "").trim();
  else if (plat === "darwin") base = home ? path.join(home, "Library", "Application Support") : "";
  else base = (env.XDG_DATA_HOME || "").trim() || (home ? path.join(home, ".local", "share") : "");
  if (!base) return null;
  return path.join(base, String(application).toLowerCase(), "trace-install-id");
}

function homeDir() {
  try { return os.homedir(); } catch (e) { return ""; }
}

function notice(s, name) {
  if (!s.enabled) return `Usage reporting is off (${s.reason}).`;
  return (
    `Usage reporting is on: ${name} sends its name, version and the names of the tools called ` +
    `to ${s.endpoint}, with a random installation ID - never tool arguments, notes, queries or anything about you. ` +
    "Turn it off with TRACE_USAGE_REPORTING=off (or DO_NOT_TRACK=1) in the server's environment, " +
    `or "enabled": false in src/usage-reporting.json. Details: ${DETAILS}`
  );
}

function readConfig() {
  try { return require(CONFIG_FILE); } catch (e) { return null; }
}

/**
 * The reporter the server uses. Never throws: a trace server that is down,
 * slow, or refusing the key costs a dropped report and nothing else.
 */
function create(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const s = settings(o.config !== undefined ? o.config : readConfig(), env);
  // The client tags every event with it and refuses a blank one, so it is
  // never blank here.
  const version = (typeof o.version === "string" && o.version.trim()) || "unknown";
  let client = null;
  if (s.enabled) {
    try {
      // `env` is handed on so the client reads the same environment this
      // module decided on, not process.env behind a test's stand-in.
      // TRACE_INSTALL_ID pins the installation ID (a container, say);
      // otherwise the client keeps one in installIdFile, which it reads or
      // creates only because it is enabled. On Node before 20.16 / 22.3 the
      // client cannot reach node:fs and uses a fresh ID for the run instead.
      client = new TraceClient(s.endpoint, s.application, {
        version,
        key: s.key,
        fetch: o.fetch,
        env,
        installId: env.TRACE_INSTALL_ID,
        installIdFile: installIdFile(s.application, env, o.platform, o.home !== undefined ? o.home : homeDir()),
      });
    } catch (e) {
      client = null; // a bad endpoint must not stop the server
    }
  }
  const report = (name, tags) => (client ? client.report(name, { tags }) : Promise.resolve());
  return {
    enabled: !!client,
    installId: client ? client.installId : null,
    reason: s.reason,
    notice: notice(s, o.name || s.application),
    startup: (transport) => report("startup", { transport }),
    toolCall: (tool) => report("tool-call", { name: tool }),
    close: (ms) => (client ? client.close(ms === undefined ? CLOSE_MS : ms) : Promise.resolve()),
  };
}

module.exports = { create, settings, environmentOptOut, installIdFile, DETAILS };
