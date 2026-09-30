import { AxiError } from "axi-sdk-js";
import { api } from "../api.js";
import { coolify, health, matchOrRaise, pick, redactValue, resolvePlacement, resolveResource, scrubbed, summarize } from "../coolify.js";
import { collapseRepeats, grepLines, redactLogText } from "../logs.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const TYPE = "application";

// Coolify returns ~40 fields per app, most of them build plumbing. These are
// the ones an agent needs to decide what to do next.
const DETAIL_FIELDS = [
  "name",
  "uuid",
  "status",
  "fqdn",
  "git_repository",
  "git_branch",
  "build_pack",
  "ports_exposes",
];

const LOG_LIMIT = 4000;

/** Seams for tests: the REST fetch and the stdin reader. */
export const io = {
  fetchImpl: undefined,
  stdin: async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  },
};

const BUILD_PACKS = ["nixpacks", "static", "dockerfile", "dockercompose"];
const HEALTH_PATH = /^[a-zA-Z0-9/\-_.~%,;]+$/;

const HELP = {
  list: helpFor({
    command: "app list",
    description: "List applications with their health",
    usage: `${BIN} app list [--status <state>] [--context <name>]`,
    flags: { "--status": "Only show apps in this state (running, exited, ...)" },
    examples: [`${BIN} app list`, `${BIN} app list --status exited`],
  }),
  get: helpFor({
    command: "app get",
    description: "Show one application by name or uuid",
    usage: `${BIN} app get <name|uuid>`,
    examples: [`${BIN} app get digivaley`],
  }),
  logs: helpFor({
    command: "app logs",
    description: "Recent container logs: redacted, repeats collapsed, truncated to stay inside the context budget",
    usage: `${BIN} app logs <name|uuid> [--lines <n>] [--grep <pattern>] [--full] [--keep-repeats]`,
    flags: {
      "--lines": "Log lines to retrieve (default 100)",
      "--grep": "Keep lines matching this case-insensitive regex (literal if the regex is invalid)",
      "--full": "Do not truncate",
      "--keep-repeats": "Do not fold repeated lines into one `[xN]` line",
    },
    examples: [
      `${BIN} app logs digivaley`,
      `${BIN} app logs digivaley --lines 1000 --grep "error|refused"`,
      `${BIN} app logs digivaley --lines 500 --full`,
    ],
  }),
  env: helpFor({
    command: "app env",
    description: "List environment variables, create or update them (`env set`), or remove them (`env delete`)",
    usage:
      `${BIN} app env <name|uuid> [--reveal]\n` +
      `${BIN} app env set <name|uuid> KEY=VALUE [KEY2=VALUE2 ...] [--build]\n` +
      `${BIN} app env delete <name|uuid> KEY [KEY2 ...]`,
    flags: {
      "--reveal": "Print secret values in clear text (list only)",
      "--build": "set: also make the variable available at build time (default: runtime only)",
      "--set": "Legacy form of `env set`: KEY=VALUE, repeatable",
    },
    notes: "Values are never echoed back, and are masked out of any error text. A value already stored is a no-op.",
    examples: [
      `${BIN} app env digivaley`,
      `${BIN} app env set digivaley NEXT_PUBLIC_APP_URL=https://new.example`,
      `${BIN} app env set digivaley NEXT_PUBLIC_API=https://api.example --build`,
      `${BIN} app env delete digivaley OLD_KEY`,
    ],
  }),
  set: helpFor({
    command: "app set",
    description: "Change settings the raw CLI has no flag for: deploy hooks, health check, watch paths, auto-deploy, webhook secret (REST PATCH)",
    usage: `${BIN} app set <name|uuid> [flags]`,
    flags: {
      "--pre-deploy / --clear-pre-deploy": "Pre-deployment command, or remove it",
      "--pre-deploy-container": "Container to run the pre-deployment command in",
      "--post-deploy / --clear-post-deploy": "Post-deployment command, or remove it",
      "--post-deploy-container": "Container to run the post-deployment command in",
      "--health-check on|off": "Enable or disable the health check",
      "--health-check-path": "Health check path (letters, digits and / - _ . ~ % , ; only)",
      "--watch-paths / --clear-watch-paths": "Glob that triggers auto-deploy, repeatable; or remove them",
      "--auto-deploy on|off": "Deploy on push",
      "--webhook-secret-github-stdin": "Read the GitHub webhook secret from stdin (preferred: keeps it out of argv and shell history)",
      "--webhook-secret-github": "The secret as an argument (lands in shell history; prefer the stdin form)",
      "--clear-webhook-secret-github": "Remove the GitHub webhook secret",
    },
    notes: "The webhook secret is write-only: the output says `set` or `cleared`, never the value.",
    examples: [
      `${BIN} app set strategist-web --pre-deploy "pnpm db:migrate" --pre-deploy-container web`,
      `${BIN} app set strategist-web --health-check on --health-check-path /api/health`,
      `printf %s "$SECRET" | ${BIN} app set strategist-web --webhook-secret-github-stdin`,
    ],
  }),
  create: helpFor({
    command: "app create",
    description: "Create an application from a git repository",
    usage:
      `${BIN} app create <name> --repo <url|owner/repo> --branch <b> --server <name|uuid> --project <name|uuid> ` +
      `[--environment <name>] [--build-pack ${BUILD_PACKS.join("|")}] [--dockerfile-target <stage>] [--port <n>] [--domain <url>] [--github-app <name|uuid>] [--instant-deploy]`,
    flags: {
      "--repo": "A git URL (public repository), or owner/repo together with --github-app",
      "--environment": "Environment name (default production)",
      "--build-pack": "Default nixpacks",
      "--port": "Exposed port (default 3000)",
      "--github-app": "GitHub App that can read the repository (needed for owner/repo)",
      "--instant-deploy": "Deploy right after creating",
    },
    examples: [
      `${BIN} app create web --repo https://github.com/acme/web --branch main --server localhost --project blog`,
      `${BIN} app create web --repo acme/web --branch main --server localhost --project blog --github-app acme-gh --build-pack dockerfile`,
    ],
  }),
  domain: helpFor({
    command: "app domain",
    description: "Show the domains an application serves, or change them",
    usage: `${BIN} app domain <name|uuid> [<domains>] [--add <domain>] [--remove <domain>]`,
    flags: {
      "--add": "Append a domain, keeping the existing ones (repeatable, idempotent)",
      "--remove": "Drop one domain, keeping the rest (repeatable, idempotent)",
    },
    examples: [
      `${BIN} app domain digivaley`,
      `${BIN} app domain digivaley --add https://new.example`,
      `${BIN} app domain digivaley https://only.example`,
    ],
  }),
  start: helpFor({
    command: "app start|stop|restart",
    description: "Change an application's run state (idempotent for start and stop)",
    usage: `${BIN} app start|stop|restart <name|uuid>`,
    examples: [`${BIN} app restart digivaley`, `${BIN} app stop weddin`],
  }),
};

function row(item) {
  const { state, health: detail } = health(item.status);
  return { name: item.name, state, health: detail || "-", uuid: item.uuid };
}

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "app list", flags: { status: { type: "string" } } });
  const options = { context: values.context };

  const all = await coolify(["resource", "list"], options);
  let apps = all.filter((item) => item.type === TYPE);
  if (values.status) {
    apps = apps.filter((item) => health(item.status).state === values.status.toLowerCase());
  }

  if (apps.length === 0) {
    return {
      apps: values.status
        ? `0 applications in state ${values.status}`
        : "0 applications on this instance",
      help: [`Run \`${BIN}\` to see every resource type`],
    };
  }
  return {
    count: `${apps.length} total`,
    summary: summarize(apps),
    apps: apps.map(row),
    help: [
      `Run \`${BIN} app get <name>\` for the domain, repo, and build pack`,
      `Run \`${BIN} app logs <name>\` for recent container logs`,
      `Run \`${BIN} deploy <name>\` to trigger a deployment`,
    ],
  };
}

async function get(argv) {
  if (wantsHelp(argv)) return HELP.get;
  const { values, positionals } = parse(argv, { command: "app get" });
  const selector = required(positionals[0], "<name|uuid>", "app get", `${BIN} app get digivaley`);
  const options = { context: values.context };

  const found = await resolveResource(selector, { ...options, type: TYPE });
  const detail = await coolify(["app", "get", found.uuid], options);
  const projected = Object.fromEntries(
    DETAIL_FIELDS.filter((field) => detail[field] !== undefined && detail[field] !== "").map(
      (field) => [field, detail[field]],
    ),
  );

  return {
    app: projected,
    help: [
      `Run \`${BIN} app logs ${found.name}\` for container logs`,
      `Run \`${BIN} app env ${found.name}\` for environment variables`,
      `Run \`${BIN} deploy ${found.name}\` to redeploy`,
    ],
  };
}

async function logs(argv) {
  if (wantsHelp(argv)) return HELP.logs;
  const { values, positionals } = parse(argv, {
    command: "app logs",
    flags: {
      lines: { type: "string" },
      full: { type: "boolean" },
      grep: { type: "string" },
      "keep-repeats": { type: "boolean" },
    },
  });
  const selector = required(positionals[0], "<name|uuid>", "app logs", `${BIN} app logs digivaley`);
  const lines = positiveInt(values.lines, "--lines", 100);
  const options = { context: values.context };

  const found = await resolveResource(selector, { ...options, type: TYPE });
  // Upstream `app logs` ignores --format and always prints plain text.
  const raw = await coolify(["app", "logs", found.uuid, "--lines", String(lines)], { ...options, json: false });
  if (!raw.trim()) {
    return { app: found.name, logs: `0 log lines returned for ${found.name}` };
  }

  const fetched = redactLogText(raw).split("\n");
  let kept = values.grep ? grepLines(fetched, values.grep) : fetched;
  if (kept.length === 0) {
    return {
      app: found.name,
      logs: `0 of ${fetched.length} lines match ${values.grep}`,
      help: [`Run \`${BIN} app logs ${found.name} --lines ${lines * 10} --grep "${values.grep}"\` to search further back`],
    };
  }
  if (!values["keep-repeats"]) kept = collapseRepeats(kept);
  const text = kept.join("\n");
  const count = { lines: `${kept.length} shown of ${fetched.length} fetched` };

  if (values.full || text.length <= LOG_LIMIT) {
    return { app: found.name, ...count, logs: text };
  }
  // AXI §3: never drop the field — truncate, size it, and name the escape hatch.
  return {
    app: found.name,
    ...count,
    logs: text.slice(-LOG_LIMIT),
    truncated: `showing last ${LOG_LIMIT} of ${text.length} chars`,
    help: [
      `Run \`${BIN} app logs ${found.name} --full\` for the complete output`,
      `Run \`${BIN} app logs ${found.name} --grep <pattern>\` to filter`,
    ],
  };
}

async function env(argv) {
  if (wantsHelp(argv)) return HELP.env;
  if (argv[0] === "set") return envSet(argv.slice(1));
  if (argv[0] === "delete") return envDelete(argv.slice(1));
  const { values, positionals } = parse(argv, {
    command: "app env",
    flags: { reveal: { type: "boolean" }, set: { type: "string", multiple: true } },
  });
  const selector = required(positionals[0], "<name|uuid>", "app env", `${BIN} app env digivaley`);
  const options = { context: values.context };

  const found = await resolveResource(selector, { ...options, type: TYPE });
  // The wrapped CLI masks values as `********` unless asked; --reveal has to
  // reach it, or it returns asterisks instead of the value.
  const vars = await coolify(
    ["app", "env", "list", found.uuid, ...(values.reveal ? ["--show-sensitive"] : [])],
    options,
  );
  const rows = Array.isArray(vars) ? vars : [];

  if (values.set?.length) return await setEnv(found, rows, values.set, options, false);

  if (rows.length === 0) {
    return { app: found.name, env: `0 environment variables set on ${found.name}` };
  }
  return {
    app: found.name,
    count: `${rows.length} total`,
    env: rows.map((entry) => ({
      key: entry.key,
      value: redactValue(entry.key, entry.value, values.reveal),
      build_time: Boolean(entry.is_build_time),
    })),
    ...(values.reveal ? {} : { note: "values redacted; pass --reveal to print them" }),
  };
}

/** `app env set <app> KEY=VALUE ... [--build]`: same create-or-update path as `--set`. */
async function envSet(argv) {
  const { values, positionals } = parse(argv, { command: "app env set", flags: { build: { type: "boolean" } } });
  const selector = required(positionals[0], "<name|uuid>", "app env set", `${BIN} app env set digivaley KEY=value`);
  if (positionals.length < 2) {
    throw new AxiError("at least one KEY=VALUE is required", "VALIDATION_ERROR", [
      `Example: ${BIN} app env set ${selector} KEY=value`,
    ]);
  }
  const options = { context: values.context };
  return await scrubbed(positionals.slice(1).map(valueOf), async () => {
    const found = await resolveResource(selector, { ...options, type: TYPE });
    const vars = await coolify(["app", "env", "list", found.uuid, "--show-sensitive"], options);
    return await setEnv(found, Array.isArray(vars) ? vars : [], positionals.slice(1), options, Boolean(values.build));
  });
}

const valueOf = (pair) => pair.slice(pair.indexOf("=") + 1);

/**
 * Create or update each KEY=VALUE. Values are compared against the current set
 * so a re-run is a no-op, and are never echoed back — several of these are
 * secrets and the output is what an agent pastes into a summary. Runtime-only
 * unless `build` is set; upstream defaults build-time to true, so it is always
 * passed explicitly.
 */
async function setEnv(found, rows, pairs, options, build) {
  const current = new Map(rows.map((entry) => [entry.key, entry]));
  const parsed = pairs.map((pair) => {
    const at = pair.indexOf("=");
    if (at < 1) {
      throw new AxiError(`${pair.slice(0, at < 0 ? 0 : at) || "argument"} is not KEY=VALUE`, "VALIDATION_ERROR", [
        `Example: ${BIN} app env set ${found.name} KEY=value`,
      ]);
    }
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
  const secrets = parsed.map(([, value]) => value);
  const applied = [];

  for (const [key, value] of parsed) {
    const existing = current.get(key);
    if (existing && existing.value === value && Boolean(existing.is_build_time) === build) {
      applied.push({ key, unchanged: true });
      continue;
    }
    // The listing masks secrets as `********` unless --show-sensitive, so an
    // unchanged secret may not be detectable — writing it again is the safe way round.
    const flags = [`--build-time=${build}`, "--runtime=true"];
    const args = existing
      ? ["app", "env", "update", found.uuid, key, "--value", value, ...flags]
      : ["app", "env", "create", found.uuid, "--key", key, "--value", value, ...flags];
    // These writes answer with a plain-text confirmation, not JSON, and the
    // payload is unused either way — parsing it would fail a successful write.
    await scrubbed(secrets, () => coolify(args, { ...options, json: false }));
    applied.push({ key, [existing ? "updated" : "created"]: true });
  }

  return {
    app: found.name,
    env: applied,
    help: [`Run \`${BIN} deploy ${found.name}\` — env changes apply on the next deployment`],
  };
}

/** `app env delete <app> KEY ...`: upstream takes the env uuid, so resolve keys first. */
async function envDelete(argv) {
  const { values, positionals } = parse(argv, { command: "app env delete" });
  const selector = required(positionals[0], "<name|uuid>", "app env delete", `${BIN} app env delete digivaley KEY`);
  const keys = positionals.slice(1);
  if (keys.length === 0) {
    throw new AxiError("at least one KEY is required", "VALIDATION_ERROR", [`Example: ${BIN} app env delete ${selector} KEY`]);
  }
  const options = { context: values.context };
  const found = await resolveResource(selector, { ...options, type: TYPE });
  const vars = await coolify(["app", "env", "list", found.uuid], options);
  const rows = Array.isArray(vars) ? vars : [];

  // Resolve every key before deleting any, so a typo cannot half-apply.
  const targets = keys.map((key) => {
    const hit = rows.find((entry) => entry.key === key);
    if (hit) return hit;
    const near = rows
      .filter((entry) => entry.key.toLowerCase().includes(key.toLowerCase()))
      .slice(0, 5)
      .map((entry) => `Did you mean ${entry.key}?`);
    throw new AxiError(`no environment variable ${key} on ${found.name}`, "NOT_FOUND", [
      ...near,
      `Run \`${BIN} app env ${found.name}\` to list the keys`,
    ]);
  });

  for (const target of targets) {
    await coolify(["app", "env", "delete", found.uuid, target.uuid, "--force"], { ...options, json: false });
  }
  return {
    app: found.name,
    env: targets.map((target) => ({ key: target.key, deleted: true })),
    help: [`Run \`${BIN} deploy ${found.name}\` — env changes apply on the next deployment`],
  };
}

const ON_OFF = { on: true, off: false };

function onOff(value, flag) {
  if (!(value in ON_OFF)) {
    throw new AxiError(`${flag} must be on or off`, "VALIDATION_ERROR", [`Example: ${flag} on`]);
  }
  return ON_OFF[value];
}

/** Settings with no raw-CLI flag: one REST PATCH of only the fields asked for. */
async function set(argv) {
  if (wantsHelp(argv)) return HELP.set;
  const { values, positionals } = parse(argv, {
    command: "app set",
    flags: {
      "pre-deploy": { type: "string" },
      "clear-pre-deploy": { type: "boolean" },
      "pre-deploy-container": { type: "string" },
      "post-deploy": { type: "string" },
      "clear-post-deploy": { type: "boolean" },
      "post-deploy-container": { type: "string" },
      "health-check": { type: "string" },
      "health-check-path": { type: "string" },
      "watch-paths": { type: "string", multiple: true },
      "clear-watch-paths": { type: "boolean" },
      "auto-deploy": { type: "string" },
      "webhook-secret-github": { type: "string" },
      "webhook-secret-github-stdin": { type: "boolean" },
      "clear-webhook-secret-github": { type: "boolean" },
    },
  });
  const selector = required(positionals[0], "<name|uuid>", "app set", `${BIN} app set digivaley --health-check on`);
  const clash = (a, b) => {
    throw new AxiError(`pass ${a} or ${b}, not both`, "VALIDATION_ERROR", [`Use one of them`]);
  };
  const body = {};
  const shown = {};
  const put = (field, value, display = value) => {
    body[field] = value;
    shown[field] = display === null ? "cleared" : typeof display === "string" ? redactLogText(display) : display;
  };
  for (const [flag, clear, field] of [
    ["pre-deploy", "clear-pre-deploy", "pre_deployment_command"],
    ["post-deploy", "clear-post-deploy", "post_deployment_command"],
  ]) {
    if (values[flag] !== undefined && values[clear]) clash(`--${flag}`, `--${clear}`);
    if (values[flag] === "") throw new AxiError(`--${flag} needs a command`, "VALIDATION_ERROR", [`Use --${clear} to remove it`]);
    if (values[flag] !== undefined) put(field, values[flag]);
    if (values[clear]) put(field, null);
  }
  if (values["pre-deploy-container"] !== undefined) put("pre_deployment_command_container", values["pre-deploy-container"]);
  if (values["post-deploy-container"] !== undefined) put("post_deployment_command_container", values["post-deploy-container"]);
  if (values["health-check"] !== undefined) put("health_check_enabled", onOff(values["health-check"], "--health-check"));
  if (values["health-check-path"] !== undefined) {
    if (!HEALTH_PATH.test(values["health-check-path"])) {
      throw new AxiError("--health-check-path has characters Coolify rejects", "VALIDATION_ERROR", [
        "Allowed: letters, digits and / - _ . ~ % , ;",
        `Example: ${BIN} app set ${selector} --health-check-path /api/health`,
      ]);
    }
    put("health_check_path", values["health-check-path"]);
  }
  if (values["watch-paths"]?.length && values["clear-watch-paths"]) clash("--watch-paths", "--clear-watch-paths");
  if (values["watch-paths"]?.length) {
    put("watch_paths", values["watch-paths"].flatMap((v) => v.split("\n")).filter(Boolean).join("\n"));
  }
  if (values["clear-watch-paths"]) put("watch_paths", null);
  if (values["auto-deploy"] !== undefined) put("is_auto_deploy_enabled", onOff(values["auto-deploy"], "--auto-deploy"));

  const webhookModes = ["webhook-secret-github", "webhook-secret-github-stdin", "clear-webhook-secret-github"].filter((f) => values[f] !== undefined && values[f] !== false);
  if (webhookModes.length > 1) clash(`--${webhookModes[0]}`, `--${webhookModes[1]}`);
  let secret;
  if (values["webhook-secret-github-stdin"]) secret = (await io.stdin()).replace(/\r?\n$/, "");
  else if (values["webhook-secret-github"] !== undefined) secret = values["webhook-secret-github"];
  if (secret !== undefined) {
    if (!secret) throw new AxiError("the webhook secret is empty", "VALIDATION_ERROR", ["Use --clear-webhook-secret-github to remove it"]);
    put("manual_webhook_secret_github", secret, "set");
  }
  if (values["clear-webhook-secret-github"]) put("manual_webhook_secret_github", null);

  if (Object.keys(body).length === 0) {
    throw new AxiError("no setting given", "VALIDATION_ERROR", [
      `Example: ${BIN} app set ${selector} --health-check on --health-check-path /api/health`,
      `Run \`${BIN} app set --help\` for every flag`,
    ]);
  }

  const options = { context: values.context };
  const found = await resolveResource(selector, { ...options, type: TYPE });
  // The response is discarded on purpose: it can echo the webhook secret.
  await scrubbed([secret], () => api("PATCH", `/applications/${found.uuid}`, body, { ...options, fetchImpl: io.fetchImpl }));
  return {
    app: found.name,
    changed: shown,
    help: [`Run \`${BIN} deploy ${found.name}\` to apply the change to a running deployment`],
  };
}

/** `app create`: git repo -> application. Names resolve to uuids; nothing secret is returned. */
async function create(argv) {
  if (wantsHelp(argv)) return HELP.create;
  const { values, positionals } = parse(argv, {
    command: "app create",
    flags: {
      repo: { type: "string" },
      branch: { type: "string" },
      server: { type: "string" },
      project: { type: "string" },
      environment: { type: "string" },
      "build-pack": { type: "string" },
      "dockerfile-target": { type: "string" },
      port: { type: "string" },
      domain: { type: "string" },
      "github-app": { type: "string" },
      "instant-deploy": { type: "boolean" },
    },
  });
  const example = `${BIN} app create web --repo https://github.com/acme/web --branch main --server localhost --project blog`;
  const name = required(positionals[0], "<name>", "app create", example);
  for (const flag of ["repo", "branch", "server", "project"]) required(values[flag], `--${flag}`, "app create", example);
  const buildPack = values["build-pack"] ?? "nixpacks";
  if (!BUILD_PACKS.includes(buildPack)) {
    throw new AxiError(`--build-pack ${buildPack} is not supported`, "VALIDATION_ERROR", [`valid build packs: ${BUILD_PACKS.join(", ")}`]);
  }
  const port = positiveInt(values.port, "--port", 3000);
  const isUrl = /^([a-z][a-z0-9+.-]*:\/\/|git@)/i.test(values.repo);
  if (!isUrl && !values["github-app"]) {
    throw new AxiError(`--repo ${values.repo} is not a URL, so a GitHub App is needed to read it`, "VALIDATION_ERROR", [
      "Pass --github-app <name|uuid>, or give the full git URL for a public repository",
    ]);
  }
  if (isUrl && values["github-app"]) {
    throw new AxiError("--github-app needs --repo as owner/repo, not a URL", "VALIDATION_ERROR", [`Example: --repo acme/web --github-app <name>`]);
  }

  const options = { context: values.context };
  const placement = await resolvePlacement(values, options);
  const source = [];
  if (values["github-app"]) {
    const gh = matchOrRaise(await coolify(["github", "list"], options), values["github-app"], "github app");
    source.push("github", "--github-app-uuid", gh.uuid);
  } else {
    source.push("public");
  }
  const args = [
    "app", "create", source[0], ...source.slice(1), ...placement,
    "--name", name, "--git-repository", values.repo, "--git-branch", values.branch,
    "--build-pack", buildPack, "--ports-exposes", String(port),
    ...(values.domain ? ["--domains", values.domain] : []),
    ...(values["dockerfile-target"] ? ["--dockerfile-target-build", values["dockerfile-target"]] : []),
    ...(values["instant-deploy"] ? ["--instant-deploy"] : []),
  ];
  const created = await coolify(args, options);
  return {
    created: { type: "application", name, ...pick(created, ["uuid", "domains"]) },
    help: [
      `Run \`${BIN} app get ${name}\` for the repo, branch, and build pack`,
      ...(values["instant-deploy"] ? [`Run \`${BIN} deploy watch ${name}\` to follow the first deployment`] : [`Run \`${BIN} deploy ${name}\` to deploy it`]),
      `Run \`${BIN} app env set ${name} KEY=value\` to add environment variables first`,
    ],
  };
}

function domainList(fqdn) {
  return String(fqdn ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function domain(argv) {
  if (wantsHelp(argv)) return HELP.domain;
  const { values, positionals } = parse(argv, {
    command: "app domain",
    flags: { add: { type: "string", multiple: true }, remove: { type: "string", multiple: true } },
  });
  const selector = required(
    positionals[0],
    "<name|uuid>",
    "app domain",
    `${BIN} app domain digivaley`,
  );
  const options = { context: values.context };
  const found = await resolveResource(selector, { ...options, type: TYPE });
  const detail = await coolify(["app", "get", found.uuid], options);
  const before = domainList(detail.fqdn);

  const replacing = positionals[1] !== undefined;
  if (!replacing && !values.add?.length && !values.remove?.length) {
    return {
      app: found.name,
      domains: before.length ? before : "no domains set",
      help: [`Run \`${BIN} app domain ${found.name} --add https://new.example\` to add one`],
    };
  }

  let after = replacing ? domainList(positionals.slice(1).join(",")) : [...before];
  for (const entry of values.add ?? []) {
    for (const one of domainList(entry)) if (!after.includes(one)) after.push(one);
  }
  for (const entry of values.remove ?? []) {
    const drop = new Set(domainList(entry));
    after = after.filter((one) => !drop.has(one));
  }

  if (after.length === 0) {
    throw new AxiError("that would leave the application with no domain", "VALIDATION_ERROR", [
      "Coolify would stop routing traffic to it entirely",
      `Pass the domains to keep: ${BIN} app domain ${found.name} https://keep.example`,
    ]);
  }
  if (after.join(",") === before.join(",")) {
    return { app: found.name, domains: after, unchanged: true, note: "already set (no-op)" };
  }

  await coolify(["app", "update", found.uuid, "--domains", after.join(",")], {
    ...options,
    json: false,
  });
  const removed = before.filter((one) => !after.includes(one));
  return {
    app: found.name,
    domains: after,
    ...(removed.length ? { removed } : {}),
    help: [
      `Run \`${BIN} deploy ${found.name}\` to issue certificates and route the new domains`,
      ...(removed.length ? ["A removed domain stops resolving to this app immediately"] : []),
    ],
  };
}

/** start/stop are declarative: already in the target state is a no-op, not an error. */
function stateChanger(action, desired) {
  return async function change(argv) {
    if (wantsHelp(argv)) return HELP.start;
    const { values, positionals } = parse(argv, { command: `app ${action}` });
    const selector = required(
      positionals[0],
      "<name|uuid>",
      `app ${action}`,
      `${BIN} app ${action} digivaley`,
    );
    const options = { context: values.context };
    const found = await resolveResource(selector, { ...options, type: TYPE });
    const state = health(found.status).state;

    if (desired && state === desired) {
      return { app: found.name, state, unchanged: true, note: `already ${desired} (no-op)` };
    }
    await coolify(["app", action, found.uuid], options);
    return {
      app: found.name,
      action,
      previous: state,
      help: [`Run \`${BIN} app get ${found.name}\` to confirm the new state`],
    };
  };
}

export const appCommand = makeDispatcher(
  "app",
  {
    list,
    get,
    logs,
    env,
    set,
    create,
    domain,
    start: stateChanger("start", "running"),
    stop: stateChanger("stop", "exited"),
    restart: stateChanger("restart", null),
  },
  {
    fallback: "list",
    summary: {
      list: "List applications with their health",
      get: "Show one application by name or uuid",
      logs: "Recent container logs: redacted, collapsed, --grep to filter",
      env: "List environment variables; `env set KEY=VALUE` / `env delete KEY` to change them",
      set: "Change deploy hooks, health check, watch paths, auto-deploy, webhook secret",
      create: "Create an application from a git repository",
      domain: "Show or change the domains an application serves",
      start: "Start an application (idempotent)",
      stop: "Stop an application (idempotent)",
      restart: "Restart an application",
    },
  },
);
