import { coolify, health, redactValue, resolveResource, summarize } from "../coolify.js";
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
    description: "Recent container logs, truncated to stay inside the context budget",
    usage: `${BIN} app logs <name|uuid> [--lines <n>] [--full]`,
    flags: { "--lines": "Log lines to retrieve (default 100)", "--full": "Do not truncate" },
    examples: [`${BIN} app logs digivaley`, `${BIN} app logs digivaley --lines 500 --full`],
  }),
  env: helpFor({
    command: "app env",
    description: "List environment variables (values redacted unless --reveal)",
    usage: `${BIN} app env <name|uuid> [--reveal]`,
    flags: { "--reveal": "Print secret values in clear text" },
    examples: [`${BIN} app env digivaley`],
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
    flags: { lines: { type: "string" }, full: { type: "boolean" } },
  });
  const selector = required(positionals[0], "<name|uuid>", "app logs", `${BIN} app logs digivaley`);
  const lines = positiveInt(values.lines, "--lines", 100);
  const options = { context: values.context };

  const found = await resolveResource(selector, { ...options, type: TYPE });
  const payload = await coolify(["app", "logs", found.uuid, "--lines", String(lines)], options);
  const text = typeof payload === "string" ? payload : (payload?.logs ?? JSON.stringify(payload));

  if (!text.trim()) {
    return { app: found.name, logs: `0 log lines returned for ${found.name}` };
  }
  if (values.full || text.length <= LOG_LIMIT) {
    return { app: found.name, lines: text.split("\n").length, logs: text };
  }
  // AXI §3: never drop the field — truncate, size it, and name the escape hatch.
  const kept = text.slice(-LOG_LIMIT);
  return {
    app: found.name,
    logs: kept,
    truncated: `showing last ${LOG_LIMIT} of ${text.length} chars`,
    help: [`Run \`${BIN} app logs ${found.name} --full\` for the complete output`],
  };
}

async function env(argv) {
  if (wantsHelp(argv)) return HELP.env;
  const { values, positionals } = parse(argv, {
    command: "app env",
    flags: { reveal: { type: "boolean" } },
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
    start: stateChanger("start", "running"),
    stop: stateChanger("stop", "exited"),
    restart: stateChanger("restart", null),
  },
  {
    fallback: "list",
    summary: {
      list: "List applications with their health",
      get: "Show one application by name or uuid",
      logs: "Recent container logs, truncated by default",
      env: "List environment variables (redacted)",
      start: "Start an application (idempotent)",
      stop: "Stop an application (idempotent)",
      restart: "Restart an application",
    },
  },
);
