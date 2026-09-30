/**
 * Free-text log handling: redaction, repeat collapsing, grep, and a
 * deployment-failure summary. Logs are the one place secrets arrive without a
 * field name to decide on, so everything that prints a log line routes through
 * `redactLogText` — there is deliberately no `--reveal` for logs.
 */

const MASK = "<redacted>";

// Secret-ish names. `pass` alone would hit "passed"/"bypass"; `_key` must end the word.
const NAME = String.raw`[A-Za-z0-9_.-]*(?:passw(?:or)?d|passwd|_pass\b|secret|token|api[_-]?key|_key\b|credential|auth|private[_-]?key)[A-Za-z0-9_.-]*`;
// Coolify wraps commands in `bash -c '…'`, so inline values arrive as '\''value'\''.
const SHELL_QUOTED = String.raw`'\\''(?:(?!'\\'')[^\n])*'\\''`;
const QUOTED_OR_BARE = String.raw`(?:${SHELL_QUOTED}|"[^"]*"|'[^']*'|[^\s"',;&]+)`;
const NOT_MASKED = String.raw`(?!${MASK})`;

const RULES = [
  // Build args carry secrets under innocent names (DATABASE_URL), so every value goes.
  [
    new RegExp(String.raw`(--build-arg[ =]+(?:'\\''|["'])?)([A-Za-z_]\w*)=(${SHELL_QUOTED}|"[^"]*"|'[^']*'|[^\s"']*)`, "g"),
    `$1$2=${MASK}`,
  ],
  [/\b(ARG\s+[A-Za-z_]\w*)=("[^"]*"|'[^']*'|\S+)/g, `$1=${MASK}`],
  // `docker run -e KEY=v` / `--env KEY=v`: same reasoning as build args.
  [
    new RegExp(String.raw`((?:^|\s)(?:-e|--env)[ =]+(?:'\\''|["'])?)([A-Za-z_]\w*)=(${SHELL_QUOTED}|"[^"]*"|'[^']*'|[^\s"']*)`, "g"),
    `$1$2=${MASK}`,
  ],
  // PEM private keys span lines; an unterminated block is masked to the end of the text.
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$(?![\s\S]))/g, `$1${MASK}$2`],
  // Credentialed URLs anywhere in a line (URL_CREDENTIALS without the ^ anchor; user may be empty).
  [/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)([^@\s]+)(@)/gi, `$1${MASK}$3`],
  // User-only userinfo is a credential too (Sentry DSNs, token-as-user git URLs).
  [/([a-z][a-z0-9+.-]*:\/\/)(?!<redacted>)([^:/@\s]+)(@)/gi, `$1${MASK}$3`],
  // Token shapes that are secrets regardless of what precedes them.
  [/\b(?:[sr]k|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}|\bxox[abprs]-[\w-]{10,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, MASK],
  [/\b(Bearer|Basic)\s+(?!<)[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`],
  // KEY=VALUE, KEY: VALUE, "key": "value" — including `Authorization: Bearer x`.
  [
    new RegExp(String.raw`\b(${NAME})(["']?[ \t]*[=:][ \t]*)${NOT_MASKED}(?:(?:Bearer|Basic|Token)\s+)?${QUOTED_OR_BARE}`, "gi"),
    `$1$2${MASK}`,
  ],
  // --password x, --api-key=x (but not --password-stdin, which takes no value).
  [
    new RegExp(String.raw`(--?[A-Za-z0-9-]*(?:pass(?:word)?|secret|token|api-?key)[A-Za-z0-9-]*)(?<!-stdin|-file)([ =])${NOT_MASKED}${QUOTED_OR_BARE}`, "gi"),
    `$1$2${MASK}`,
  ],
  // `token abc123…` — a long opaque value right after a secret-ish name.
  [new RegExp(String.raw`\b(${NAME})(\s+)${NOT_MASKED}[A-Za-z0-9+/_=.-]{20,}`, "gi"), `$1$2${MASK}`],
];

export function redactLogText(text) {
  if (!text) return text ?? "";
  let out = String(text);
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

const TIMESTAMP = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?Z?|\b\d\d:\d\d:\d\d(?:\.\d+)?\b/g;

/**
 * Fold repeated lines (compared with timestamps stripped) into their first
 * occurrence plus an `[xN]` count. ponytail: global, not just consecutive — a
 * reconnect flood interleaves with stack lines, and order of first sight is
 * kept, so the timeline of *new* messages survives.
 */
export function collapseRepeats(lines) {
  const seen = new Map();
  const kept = [];
  for (const line of lines) {
    const key = line.replace(TIMESTAMP, "").trim();
    if (seen.has(key)) {
      seen.get(key).count += 1;
      continue;
    }
    const slot = { line, count: 1 };
    seen.set(key, slot);
    kept.push(slot);
  }
  return kept.map(({ line, count }) => (count > 1 ? `${line} [x${count}]` : line));
}

/** Case-insensitive regex filter; an invalid regex is matched literally. */
export function grepLines(lines, pattern) {
  let regex;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  return lines.filter((line) => regex.test(line));
}

/**
 * Coolify's deployment log entries, redacted, with debug (`hidden`) entries
 * dropped unless asked for. Accepts the array or the JSON string the API stores.
 */
export function normalizeEntries(raw, { debug = false } = {}) {
  let entries = raw;
  if (typeof raw === "string") {
    try {
      entries = JSON.parse(raw);
    } catch {
      entries = raw.split("\n").map((output) => ({ output }));
    }
  }
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => debug || !entry.hidden)
    .map((entry) => ({
      time: String(entry.timestamp ?? "").match(/\d\d:\d\d:\d\d/)?.[0] ?? "",
      command: entry.command ? redactLogText(entry.command) : null,
      output: redactLogText(entry.output ?? ""),
      stderr: entry.type === "stderr",
    }));
}

/** One record per output line; `block` keeps the whole entry output for context checks. */
function flatten(entries) {
  return entries.flatMap((entry) =>
    entry.output
      .split("\n")
      .filter((text) => text.trim())
      .map((text) => ({ ...entry, text, block: entry.output })),
  );
}

/** `--full` view: `HH:MM:SS [$ command] output`, repeats collapsed. */
export function renderEntries(entries) {
  const lines = entries.flatMap((entry) => [
    ...(entry.command ? [`${entry.time} $ ${entry.command}`] : []),
    ...entry.output
      .split("\n")
      .filter((text) => text.trim())
      .map((text) => `${entry.time} ${text}`),
  ]);
  return collapseRepeats(lines);
}

/** API-triggered deploys record `HEAD`; the ls-remote / checkout lines carry the real SHA. */
export function resolvedCommit(entries, commit) {
  if (commit && commit !== "HEAD") return commit;
  for (const entry of entries) {
    const text = `${entry.command ?? ""} ${entry.output}`;
    if (!/refs\/heads|checking out|commit|git /i.test(text)) continue;
    const sha = text.match(/\b[0-9a-f]{40}\b/)?.[0];
    if (sha) return sha;
  }
  return commit || "HEAD";
}

export function duration(from, to) {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

const ERROR = /\b(error|failed|fatal|exception|denied|refused|cannot|could not)\b|exit code [1-9]/i;
// Stack frames, banners, and Coolify's own cleanup chatter.
const NOISE = /^\s*at |^#\d+ \/|^[=-]{8,}$|No such container|^Error (type|code):|^Location:|^Stack trace/i;
const HEALTH = /health ?check/i;
const ROLLBACK = /rolling back|rolled back|rollback/i;
// Coolify's canonical failure line, e.g. "Deployment failed: Command execution failed (exit code 1): <cmd>".
const FAILED = /deployment failed:|command execution failed|oops something is not okay|pre-deployment command:.*\bfailed\b/i;
const MAX_ERROR_LINES = 20;
const clip = (text, n = 200) => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * Decision-ready summary of one deployment: status, why it failed, the command
 * that failed with its error lines, health-check attempts, and any rollback.
 * `entries` must come from `normalizeEntries` (already redacted). Tuned on real
 * Coolify v4 logs; unknown shapes fall back to the first error line.
 */
export function summarizeDeployment(entries, deployment = {}) {
  const lines = flatten(entries);
  const took = duration(deployment.created_at, deployment.finished_at);
  const summary = { status: deployment.status ?? "unknown", ...(took ? { duration: took } : {}) };
  const isError = (line) =>
    ERROR.test(line.text) && !NOISE.test(line.text) && !HEALTH.test(line.block) && !ROLLBACK.test(line.text);

  const attempts = lines.filter((line) => /attempt \d+ of \d+/i.test(line.text));
  const healthLogs = lines.filter((line) => /healthcheck logs/i.test(line.text));
  const rollback = lines.find((line) => ROLLBACK.test(line.text));
  const anchor = lines.findLastIndex((line) => FAILED.test(line.text));
  const preDeploy = lines.some((line) => /pre-deployment command|run_pre_deployment_command/i.test(line.text));
  const failing = !["finished", "success", "queued", "in_progress"].includes(summary.status) || Boolean(rollback);

  const reasons = [];
  let failedCommand;
  if (anchor >= 0) {
    const text = lines[anchor].text;
    const code = text.match(/exit code (\d+)/i)?.[1];
    const cause = lines.slice(anchor + 1, anchor + 4).find(isError)?.text;
    reasons.push(
      `${preDeploy ? "pre-deployment command" : "command"} failed${code ? ` (exit code ${code})` : ""}${cause ? `: ${clip(cause)}` : ""}`,
    );
    failedCommand =
      text.match(/exit code \d+\)?:\s*(.+)$/i)?.[1] ??
      text.match(/pre-deployment command:\s*(.+?)\s+failed\b/i)?.[1] ??
      lines.slice(0, anchor + 1).reverse().find((line) => line.command)?.command;
  }
  const unhealthy =
    lines.some((line) => /not healthy|is unhealthy/i.test(line.text)) ||
    /unhealthy/i.test(attempts.at(-1)?.text ?? "");
  if (unhealthy) {
    const missing = [...new Set(lines.flatMap((line) => [...line.text.matchAll(/(\w+): not found/g)].map((m) => m[1])))];
    reasons.push(`new container failed its health check${missing.length ? ` (${missing.join(", ")}: not found in the image)` : ""}`);
  }
  if (failing && reasons.length === 0) {
    const first = lines.find(isError);
    if (first) {
      reasons.push(clip(first.text));
      failedCommand = lines.slice(0, lines.indexOf(first) + 1).reverse().find((line) => line.command)?.command;
    }
  }

  if (reasons.length) summary.reason = reasons.join("; then ");
  if (failedCommand) summary.failed_command = clip(failedCommand);

  // Error lines near the failure. A health-only failure is fully described by
  // the health fields; earlier build errors there are noise, not the cause.
  if (failing && (anchor >= 0 || !unhealthy)) {
    const window = anchor >= 0 ? lines.slice(Math.max(0, anchor - 40), anchor + 4) : lines;
    const errors = collapseRepeats(window.filter(isError).map((line) => clip(line.text, 300)));
    if (errors.length) {
      summary.errors = errors.slice(-MAX_ERROR_LINES);
      if (errors.length > MAX_ERROR_LINES) summary.errors_truncated = `showing last ${MAX_ERROR_LINES} of ${errors.length}`;
    }
  }
  if (attempts.length) {
    const last = [attempts.at(-1)?.text, healthLogs.at(-1)?.text].filter(Boolean).map((t) => clip(t, 160));
    summary.health_checks = `${attempts.length} attempts, last: ${last.join(" | ")}`;
  }
  if (rollback) summary.rollback = clip(rollback.text);
  if (!summary.reason) summary.last_lines = lines.slice(-5).map((line) => clip(line.text, 300));
  return summary;
}
