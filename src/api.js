import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { BIN } from "./args.js";
import { redactLogText } from "./logs.js";

/**
 * Minimal Coolify REST client for the operations the wrapped CLI has no flag
 * for (e.g. pre-deployment commands). It reuses the CLI's own config file, so
 * contexts and tokens still have one owner. The token goes into one header and
 * nowhere else: errors carry a redacted `message` from the body, never the body.
 */
export function configPath(env = process.env) {
  return env.COOLIFY_AXI_CONFIG || join(homedir(), ".config", "coolify", "config.json");
}

function instance(context, env) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath(env), "utf8"));
  } catch {
    throw new AxiError("no readable Coolify config", "VALIDATION_ERROR", [
      "Configure a context with the `coolify` CLI (`coolify context add ...`)",
      `Run \`${BIN} context\` to check the configured instances`,
    ]);
  }
  const instances = Array.isArray(config.instances) ? config.instances : [];
  const found = context
    ? instances.find((item) => item.name === context)
    : instances.find((item) => item.default);
  if (!found) {
    throw new AxiError(
      context ? `no Coolify context named ${context}` : "no default Coolify context",
      "VALIDATION_ERROR",
      [`configured contexts: ${instances.map((item) => item.name).join(", ") || "none"}`, `Run \`${BIN} context\``],
    );
  }
  if (!found.token || !found.fqdn) {
    throw new AxiError(`context ${found.name} has no token or URL`, "AUTH_ERROR", [
      "Add an API token for it with the `coolify` CLI",
    ]);
  }
  return found;
}

const STATUS = {
  401: ["AUTH_ERROR", "Check the token for this context is still valid in the Coolify dashboard"],
  403: ["AUTH_ERROR", "The token lacks permission; create one with write access in the Coolify dashboard"],
  404: ["NOT_FOUND", `Run \`${BIN}\` to list resources and their uuids`],
  409: ["CONFLICT", "The resource changed or is busy; re-read it and retry"],
  422: ["VALIDATION_ERROR", "Fix the listed fields and retry"],
};

/**
 * `api(method, path, body, { context, env, fetchImpl })` → parsed JSON (or text
 * when the body is not JSON, or null when empty). `path` is relative to
 * `/api/v1`, e.g. `/applications/<uuid>`.
 */
export async function api(method, path, body, options = {}) {
  const { context, env = process.env, fetchImpl = globalThis.fetch } = options;
  const target = instance(context, env);
  const url = `${target.fqdn.replace(/\/+$/, "")}/api/v1${path}`;
  const scrub = (text) => redactLogText(String(text ?? "")).replaceAll(target.token, "<redacted>");

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${target.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new AxiError(`could not reach ${new URL(url).host}`, "COOLIFY_ERROR", [
      scrub(error.cause?.code ?? error.message),
      `Run \`${BIN} context\` to check the instance URL`,
    ]);
  }

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = response.ok ? raw : null;
  }
  if (response.ok) return parsed;

  const [code, hint] = STATUS[response.status] ?? ["COOLIFY_ERROR", `Retry; if it persists, check the instance with \`${BIN} context\``];
  const message = parsed?.message ? scrub(parsed.message).slice(0, 300) : `HTTP ${response.status}`;
  // 422 names the offending fields; values are not echoed.
  const fields = parsed?.errors && typeof parsed.errors === "object" ? Object.keys(parsed.errors) : [];
  throw new AxiError(`${method} ${path}: ${message}`, code, [
    ...(fields.length ? [`invalid fields: ${fields.join(", ")}`] : []),
    hint,
  ]);
}
