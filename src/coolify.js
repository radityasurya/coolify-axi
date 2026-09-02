import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AxiError } from "axi-sdk-js";

const exec = promisify(execFile);

// Coolify app payloads carry base64 Traefik labels and raw compose files; a
// three-app `app list` is ~32 KB. Give the buffer room, then project it down.
const MAX_BUFFER = 64 * 1024 * 1024;

const SECRET_KEY = /pass(word)?|secret|token|_key$|credential/i;

// Connection strings carry the password inline under an innocent key name
// (`internal_db_url`), so key-name matching alone leaks them.
const URL_CREDENTIALS = /^([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s]+)(@)/i;
const REDACTED = "<redacted — pass --reveal>";

export function binaryPath(env = process.env) {
  return env.COOLIFY_AXI_BIN || "coolify";
}

/** The CLI writes an update banner to stderr; it is noise, not a diagnostic. */
function meaningfulStderr(stderr = "") {
  return stderr
    .split("\n")
    .filter((line) => line.trim() && !/^A new version .* is available/.test(line))
    .join("\n")
    .trim();
}

function translate(error, argv) {
  if (error.code === "ENOENT") {
    return new AxiError("the `coolify` CLI is not installed or not on PATH", "MISSING_DEPENDENCY", [
      "Install it from https://github.com/coollabsio/coolify-cli",
      "Or point COOLIFY_AXI_BIN at the binary",
    ]);
  }
  const detail = meaningfulStderr(error.stderr) || error.message;
  const cleaned = detail.replace(/^Error:\s*/i, "").split("\n")[0];

  if (/unauthor|401|invalid token|authentication/i.test(cleaned)) {
    return new AxiError(cleaned, "AUTH_ERROR", [
      "Check the token for this context is still valid in the Coolify dashboard",
      "Run `coolify-axi context` to see which instance is targeted",
    ]);
  }
  if (/not found|404|no such/i.test(cleaned)) {
    return new AxiError(cleaned, "NOT_FOUND", ["Run `coolify-axi` to list resources and their uuids"]);
  }
  if (/context/i.test(cleaned)) {
    return new AxiError(cleaned, "VALIDATION_ERROR", ["Run `coolify-axi context` to list configured instances"]);
  }
  return new AxiError(cleaned, "COOLIFY_ERROR", [`while running \`coolify ${argv.join(" ")}\``]);
}

/**
 * Run the wrapped CLI and return parsed JSON. Structured output only —
 * the wrapped tool's own stdout formatting never reaches the agent.
 */
export async function coolify(args, options = {}) {
  const { context, env = process.env, json = true, execImpl = exec } = options;
  const argv = [...args, ...(context ? ["--context", context] : []), ...(json ? ["--format", "json"] : [])];

  let stdout;
  try {
    ({ stdout } = await execImpl(binaryPath(env), argv, { maxBuffer: MAX_BUFFER, env }));
  } catch (error) {
    throw translate(error, argv);
  }

  if (!json) return stdout.trim();
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new AxiError("the `coolify` CLI returned output that is not JSON", "COOLIFY_ERROR", [
      `while running \`coolify ${argv.join(" ")}\``,
      "Upgrade the CLI with `coolify update` if this persists",
    ]);
  }
}

/** Contexts live in the CLI's own config; read it rather than shelling out. */
export async function contexts(options = {}) {
  const rows = await coolify(["context", "list"], options);
  return Array.isArray(rows) ? rows : [];
}

export async function currentContext(options = {}) {
  if (options.context) return options.context;
  const found = (await contexts(options)).find((row) => row.default || row.is_default);
  return found?.name;
}

/**
 * Coolify returns connection secrets inline on database and env payloads.
 * Redact by default — an agent printing a transcript must not leak them.
 */
/**
 * Mask one value, deciding from the NAME it is filed under. Env vars are
 * `{ key, value }` pairs, so the deciding name is the variable's own key —
 * never the record's field names.
 */
export function redactValue(name, value, reveal = false) {
  if (reveal || !value) return value;
  if (SECRET_KEY.test(name)) return REDACTED;
  if (typeof value === "string" && URL_CREDENTIALS.test(value)) {
    return value.replace(URL_CREDENTIALS, "$1<redacted>$3");
  }
  return value;
}

export function redact(record, reveal = false) {
  if (reveal) return record;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (SECRET_KEY.test(key) && value) return [key, REDACTED];
      if (typeof value === "string" && URL_CREDENTIALS.test(value)) {
        return [key, value.replace(URL_CREDENTIALS, "$1<redacted>$3")];
      }
      return [key, value];
    }),
  );
}

/** `running:healthy` -> healthy/running split an agent can filter on. */
export function health(status = "") {
  const [state, detail] = String(status).split(":");
  return { state: state || "unknown", health: detail || "" };
}

export function summarize(items, field = "status") {
  const counts = {};
  for (const item of items) {
    const state = health(item[field]).state;
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
}

/**
 * The wrapped CLI addresses everything by uuid, but agents know names. Accept
 * either, and refuse to guess when a name is ambiguous.
 */
export async function resolveResource(selector, options = {}) {
  const { type } = options;
  const all = await coolify(["resource", "list"], options);
  const pool = type ? all.filter((item) => item.type === type) : all;

  const byUuid = pool.find((item) => item.uuid === selector);
  if (byUuid) return byUuid;

  const wanted = String(selector).toLowerCase();
  const byName = pool.filter((item) => String(item.name).toLowerCase() === wanted);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new AxiError(`${byName.length} resources are named ${selector}`, "VALIDATION_ERROR", [
      "Pass the uuid instead",
      ...byName.map((item) => `uuid ${item.uuid} -> ${item.type}`),
    ]);
  }

  const near = pool
    .filter((item) => String(item.name).toLowerCase().includes(wanted))
    .slice(0, 5)
    .map((item) => `Run with ${item.name}`);
  throw new AxiError(`no ${type ?? "resource"} named ${selector}`, "NOT_FOUND", [
    ...near,
    "Run `coolify-axi` to list every resource",
  ]);
}
