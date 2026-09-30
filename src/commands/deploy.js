import { AxiError } from "axi-sdk-js";
import { coolify, resolveResource } from "../coolify.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";
import { duration, normalizeEntries, renderEntries, resolvedCommit, summarizeDeployment } from "../logs.js";

/** Injectable so tests poll without waiting. */
export const timing = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const IN_FLIGHT = new Set(["queued", "in_progress"]);
const WAIT_FLAGS = { interval: { type: "string" }, timeout: { type: "string" } };
const WAIT_HELP = {
  "--interval": "Seconds between polls (default 5)",
  "--timeout": "Give up after this many seconds (default 300); keep your shell timeout above it",
};

const HELP = {
  run: helpFor({
    command: "deploy run",
    description:
      "Trigger a deployment for an application or service, by name or uuid. The result includes the new deployment uuid; follow it with `deploy watch <app> <uuid>` or pass --wait. `deploy <name>` is shorthand for `deploy run <name>`",
    usage: `${BIN} deploy [run] <name|uuid> [--force] [--docker-tag <tag>] [--wait]`,
    flags: {
      "--force": "Rebuild without using the layer cache",
      "--docker-tag": "Override the image tag for this deployment",
      "--wait": "Poll until the deployment finishes, then print its summary (same as `deploy watch <app> <uuid>`)",
      ...WAIT_HELP,
    },
    examples: [`${BIN} deploy run digivaley`, `${BIN} deploy digivaley --wait`, `${BIN} deploy watch digivaley <deployment-uuid>`],
  }),
  list: helpFor({
    command: "deploy list",
    description: "List in-flight deployments across the instance",
    usage: `${BIN} deploy list [--limit <n>]`,
    flags: { "--limit": "Maximum deployments to return (default 20)" },
    examples: [`${BIN} deploy list`],
  }),
  history: helpFor({
    command: "deploy history",
    description: "Past deployments of one application, newest first",
    usage: `${BIN} deploy history <app> [--limit <n>]`,
    flags: { "--limit": "Maximum deployments to return (default 10)" },
    examples: [`${BIN} deploy history digivaley`, `${BIN} deploy history digivaley --limit 30`],
  }),
  logs: helpFor({
    command: "deploy logs",
    description: "Why a deployment failed: status, failing command, error lines, health checks, rollback. Always redacted",
    usage: `${BIN} deploy logs <app> [<deployment-uuid>] [--full] [--debug]`,
    flags: {
      "--full": "The whole build log (redacted, repeats collapsed) instead of the summary",
      "--debug": "Include Coolify's hidden debug entries",
    },
    examples: [`${BIN} deploy logs digivaley`, `${BIN} deploy logs digivaley <deployment-uuid> --full`],
  }),
  watch: helpFor({
    command: "deploy watch",
    description: "Poll a deployment until it finishes, fails, or is cancelled, then summarize it",
    usage: `${BIN} deploy watch <app> [<deployment-uuid>] [--interval <s>] [--timeout <s>]`,
    flags: WAIT_HELP,
    examples: [`${BIN} deploy watch digivaley`, `${BIN} deploy watch digivaley <deployment-uuid> --timeout 600`],
  }),
};

function row(item) {
  return {
    resource: item.application_name ?? item.resource_name ?? item.name ?? "-",
    status: item.status ?? "-",
    uuid: item.deployment_uuid ?? item.uuid ?? "-",
    started: item.created_at ?? "-",
  };
}

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "deploy list", flags: { limit: { type: "string" } } });
  const limit = positiveInt(values.limit, "--limit", 20);
  const rows = await coolify(["deploy", "list"], { context: values.context });

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      deployments: "0 deployments in flight",
      help: [`Run \`${BIN} deploy history <app>\` for past deployments`],
    };
  }
  return {
    count: `${Math.min(rows.length, limit)} of ${rows.length} total`,
    deployments: rows.slice(0, limit).map(row),
  };
}

/**
 * Deployment payloads are JSON, but the empty cases print plain text even with
 * --format json ("No deployments found…"), so parse here instead of in coolify().
 */
async function jsonOrText(args, options) {
  const text = await coolify([...args, "--format", "json"], { ...options, json: false });
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function appDeployments(found, options) {
  const rows = await jsonOrText(["app", "deployments", "list", found.uuid], options);
  return (Array.isArray(rows) ? rows : []).sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
}

async function getDeployment(found, uuid, options) {
  const result = await jsonOrText(["deploy", "get", uuid], options);
  const deployment = Array.isArray(result) ? result[0] : result;
  if (!deployment || typeof deployment !== "object") {
    throw new AxiError(`no deployment ${uuid}`, "NOT_FOUND", [`Run \`${BIN} deploy history ${found.name}\` to list deployment uuids`]);
  }
  // A uuid from another app would otherwise be reported under this app's name.
  if (deployment.application_name && deployment.application_name !== found.name) {
    throw new AxiError(`deployment ${uuid} belongs to ${deployment.application_name}, not ${found.name}`, "VALIDATION_ERROR", [
      `Run \`${BIN} deploy logs ${deployment.application_name} ${uuid}\``,
    ]);
  }
  return deployment;
}

/** The given deployment, or the app's latest. */
async function pick(found, uuid, options) {
  if (uuid) return getDeployment(found, uuid, options);
  const [latest] = await appDeployments(found, options);
  if (!latest) {
    throw new AxiError(`${found.name} has no deployments`, "NOT_FOUND", [`Run \`${BIN} deploy ${found.name}\` to start one`]);
  }
  return latest;
}

const stamp = (value) => (value ? String(value).replace("T", " ").slice(0, 19) : "-");
const shortSha = (sha) => (/^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha);
const clip = (text, n) => (text && text.length > n ? `${text.slice(0, n)}…` : text || "-");

function commitOf(deployment) {
  const commit = deployment.commit || "HEAD";
  // ponytail: parses the stored log only for HEAD deploys; it is already in the payload.
  return shortSha(commit === "HEAD" ? resolvedCommit(normalizeEntries(deployment.logs, { debug: true }), commit) : commit);
}

async function history(argv) {
  if (wantsHelp(argv)) return HELP.history;
  const { values, positionals } = parse(argv, { command: "deploy history", flags: { limit: { type: "string" } } });
  const selector = required(positionals[0], "<app>", "deploy history", `${BIN} deploy history digivaley`);
  const limit = positiveInt(values.limit, "--limit", 10);
  const options = { context: values.context };
  const found = await resolveResource(selector, { ...options, type: "application" });
  const rows = await appDeployments(found, options);

  if (rows.length === 0) {
    return {
      app: found.name,
      deployments: `0 deployments recorded for ${found.name}`,
      help: [`Run \`${BIN} deploy ${found.name}\` to start one`],
    };
  }
  return {
    app: found.name,
    count: `${Math.min(rows.length, limit)} of ${rows.length} total`,
    deployments: rows.slice(0, limit).map((item) => ({
      uuid: item.deployment_uuid,
      status: item.status,
      commit: commitOf(item),
      message: clip(item.commit_message?.split("\n")[0], 60),
      created: stamp(item.created_at),
      finished: stamp(item.finished_at),
      duration: duration(item.created_at, item.finished_at) ?? "-",
    })),
    help: [
      `Run \`${BIN} deploy logs ${found.name} <uuid>\` for why a deployment failed`,
      ...(rows.length > limit ? [`Run \`${BIN} deploy history ${found.name} --limit ${rows.length}\` for all ${rows.length}`] : []),
    ],
  };
}

function report(found, deployment, { debug = false } = {}) {
  const entries = normalizeEntries(deployment.logs, { debug });
  return {
    app: found.name,
    deployment: deployment.deployment_uuid,
    commit: commitOf(deployment),
    ...summarizeDeployment(entries, deployment),
  };
}

async function logs(argv) {
  if (wantsHelp(argv)) return HELP.logs;
  const { values, positionals } = parse(argv, {
    command: "deploy logs",
    flags: { full: { type: "boolean" }, debug: { type: "boolean" } },
  });
  const selector = required(positionals[0], "<app>", "deploy logs", `${BIN} deploy logs digivaley`);
  const options = { context: values.context };
  const found = await resolveResource(selector, { ...options, type: "application" });
  const deployment = await pick(found, positionals[1], options);
  const uuid = deployment.deployment_uuid;

  if (!values.full) {
    return {
      ...report(found, deployment, { debug: values.debug }),
      help: [`Run \`${BIN} deploy logs ${found.name} ${uuid} --full\` for the whole redacted log`],
    };
  }
  const lines = renderEntries(normalizeEntries(deployment.logs, { debug: values.debug }));
  if (lines.length === 0) {
    return { app: found.name, deployment: uuid, status: deployment.status, log: `0 log lines recorded for deployment ${uuid}` };
  }
  return {
    app: found.name,
    deployment: uuid,
    status: deployment.status,
    lines: lines.length,
    log: lines,
    ...(values.debug ? {} : { help: [`Run with --debug to include Coolify's hidden debug entries`] }),
  };
}

/** Poll `deploy get` until the deployment leaves queued/in_progress or the timeout passes. */
async function waitFor(found, uuid, values, options) {
  const interval = positiveInt(values.interval, "--interval", 5) * 1000;
  const timeout = positiveInt(values.timeout, "--timeout", 300);
  const start = timing.now();
  for (;;) {
    const deployment = await getDeployment(found, uuid, options);
    if (!IN_FLIGHT.has(deployment.status)) {
      const summary = report(found, deployment);
      return {
        ...summary,
        ...(summary.status === "finished"
          ? {}
          : { help: [`Run \`${BIN} deploy logs ${found.name} ${uuid} --full\` for the whole redacted log`] }),
      };
    }
    if (timing.now() - start >= timeout * 1000) {
      return {
        app: found.name,
        deployment: uuid,
        status: deployment.status,
        timed_out: `still ${deployment.status} after ${timeout}s`,
        help: [`Run \`${BIN} deploy watch ${found.name} ${uuid}\` to keep watching`],
      };
    }
    await timing.sleep(interval);
  }
}

async function watch(argv) {
  if (wantsHelp(argv)) return HELP.watch;
  const { values, positionals } = parse(argv, { command: "deploy watch", flags: WAIT_FLAGS });
  const selector = required(positionals[0], "<app>", "deploy watch", `${BIN} deploy watch digivaley`);
  const options = { context: values.context };
  const found = await resolveResource(selector, { ...options, type: "application" });
  const uuid = positionals[1] ?? (await pick(found, undefined, options)).deployment_uuid;
  return waitFor(found, uuid, values, options);
}

async function run(argv) {
  if (wantsHelp(argv)) return HELP.run;
  const { values, positionals } = parse(argv, {
    command: "deploy run",
    flags: { force: { type: "boolean" }, "docker-tag": { type: "string" }, wait: { type: "boolean" }, ...WAIT_FLAGS },
  });
  const selector = required(positionals[0], "<name|uuid>", "deploy run", `${BIN} deploy run digivaley`);
  const options = { context: values.context };
  const found = await resolveResource(selector, options);

  const args = ["deploy", "uuid", found.uuid];
  if (values.force) args.push("--force");
  if (values["docker-tag"]) args.push("--docker-tag", values["docker-tag"]);
  const result = await jsonOrText(args, options);

  // Seen shapes: { deployments: [{...}] }, [{...}], {...}, or plain text.
  const deployment = result?.deployments?.[0] ?? (Array.isArray(result) ? result[0] : result);
  const uuid =
    (typeof deployment === "object" ? deployment?.deployment_uuid : undefined) ??
    (typeof result === "string" ? result.match(/deployment[_ ]uuid\W+([a-z0-9]{8,})/i)?.[1] : undefined);

  if (values.wait) {
    // No fallback to "latest": right after a trigger that can still be the
    // previous, finished deployment, and its result would be reported as this one's.
    if (!uuid) {
      throw new AxiError(`the deployment of ${found.name} started, but its uuid was not reported`, "COOLIFY_ERROR", [
        `Run \`${BIN} deploy list\` to find it, then \`${BIN} deploy watch ${found.name} <uuid>\``,
      ]);
    }
    return waitFor(found, uuid, values, options);
  }

  return {
    deploying: found.name,
    type: found.type,
    ...(uuid ? { deployment: uuid } : {}),
    ...(typeof deployment === "object" && deployment?.message ? { message: deployment.message } : {}),
    help: [
      `Run \`${BIN} deploy watch ${found.name}${uuid ? ` ${uuid}` : ""}\` to wait for the result`,
      `Run \`${BIN} deploy logs ${found.name}${uuid ? ` ${uuid}` : ""}\` if it fails`,
    ],
  };
}

const HANDLERS = { run, list, history, logs, watch };

const dispatch = makeDispatcher("deploy", HANDLERS, {
  fallback: "list",
  summary: {
    run: "Trigger a deployment by name or uuid (--wait to follow it)",
    list: "List in-flight deployments across the instance",
    history: "Past deployments of one app, newest first",
    logs: "Why a deployment failed (summary; --full for the redacted log)",
    watch: "Poll a deployment until it ends, then summarize it",
  },
});

/**
 * Deploying is the common case, so `deploy <name>` is accepted as shorthand for
 * `deploy run <name>` — anything that is not a known subcommand is a resource.
 */
export async function deployCommand(argv) {
  const [first] = argv;
  if (first && !first.startsWith("-") && !Object.hasOwn(HANDLERS, first)) {
    return run(argv);
  }
  return dispatch(argv);
}
