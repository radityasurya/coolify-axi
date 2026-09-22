import { AxiError } from "axi-sdk-js";
import { coolify, health, matchOrRaise, redactValue, summarize } from "../coolify.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

// `service list` rows carry the full docker-compose source; the detail view is
// an allow-list so that noise never reaches the agent.
const DETAIL_FIELDS = ["name", "uuid", "status", "description", "fqdn"];

const HELP = {
  list: helpFor({
    command: "service list",
    description: "List one-click services",
    usage: `${BIN} service list [--context <name>]`,
    examples: [`${BIN} service list`],
  }),
  get: helpFor({
    command: "service get",
    description: "Show one service by name or uuid",
    usage: `${BIN} service get <name|uuid>`,
    examples: [`${BIN} service get cAdvisor`],
  }),
  create: helpFor({
    command: "service create",
    description: "Create a one-click service from a template type",
    usage:
      `${BIN} service create <type> --project-uuid <uuid> --server-uuid <uuid> ` +
      `[--environment-name <name>|--environment-uuid <uuid>] [--name <name>] ` +
      `[--description <text>] [--docker-compose <content>] [--instant-deploy]`,
    flags: {
      "--project-uuid": "Project to create the service in (required)",
      "--server-uuid": "Server to create the service on (required)",
      "--environment-name": "Environment by name (for example production); replaces --environment-uuid",
      "--environment-uuid": "Environment by uuid; replaces --environment-name",
      "--name": "Service name; the type when omitted",
      "--description": "Service description",
      "--docker-compose": "Custom Docker Compose content, replacing the template's own",
      "--instant-deploy": "Deploy immediately after creation",
      "--list-types": "Print every valid <type> instead of creating anything",
    },
    examples: [
      `${BIN} service create --list-types`,
      `${BIN} service create n8n --project-uuid <uuid> --server-uuid <uuid> --environment-name production`,
    ],
  }),
  delete: helpFor({
    command: "service delete",
    description: "Delete a service and its volumes; refuses without --yes",
    usage: `${BIN} service delete <name|uuid> --yes`,
    flags: { "--yes": "Delete for real; without it, only name what would be deleted" },
    examples: [`${BIN} service delete cAdvisor`, `${BIN} service delete cAdvisor --yes`],
  }),
  start: helpFor({
    command: "service start|stop|restart",
    description: "Change a service's run state (idempotent for start and stop)",
    usage: `${BIN} service start|stop|restart <name|uuid>`,
    examples: [`${BIN} service restart cAdvisor`, `${BIN} service stop cAdvisor`],
  }),
  env: helpFor({
    command: "service env",
    description: "List a service's environment variables, or set them with --set (idempotent)",
    usage: `${BIN} service env <name|uuid> [--reveal] [--set KEY=VALUE ...]`,
    flags: {
      "--reveal": "Print secret values in clear text",
      "--set": "KEY=VALUE to create or update, repeatable; values are never echoed back",
    },
    examples: [
      `${BIN} service env cAdvisor`,
      `${BIN} service env cAdvisor --set N8N_HOST=https://n8n.example`,
    ],
  }),
};

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "service list" });
  const rows = await coolify(["service", "list"], { context: values.context });

  if (rows.length === 0) return { services: "0 services on this instance" };
  return {
    count: `${rows.length} total`,
    summary: summarize(rows),
    services: rows.map((item) => ({
      name: item.name,
      state: health(item.status).state,
      uuid: item.uuid,
    })),
    help: [`Run \`${BIN} service get <name>\` for details`],
  };
}

async function get(argv) {
  if (wantsHelp(argv)) return HELP.get;
  const { values, positionals } = parse(argv, { command: "service get" });
  const selector = required(positionals[0], "<name|uuid>", "service get", `${BIN} service get cAdvisor`);
  const options = { context: values.context };

  const rows = await coolify(["service", "list"], options);
  const found = matchOrRaise(rows, selector, "service");

  const detail = await coolify(["service", "get", found.uuid], options);
  return {
    service: Object.fromEntries(
      DETAIL_FIELDS.filter((field) => detail[field] !== undefined && detail[field] !== "").map(
        (field) => [field, detail[field]],
      ),
    ),
  };
}

async function create(argv) {
  if (wantsHelp(argv)) return HELP.create;
  const { values, positionals } = parse(argv, {
    command: "service create",
    flags: {
      "project-uuid": { type: "string" },
      "server-uuid": { type: "string" },
      "environment-name": { type: "string" },
      "environment-uuid": { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      "docker-compose": { type: "string" },
      "instant-deploy": { type: "boolean" },
      "list-types": { type: "boolean" },
    },
  });
  const options = { context: values.context };

  // The wrapped CLI prints a plain-text catalogue here, JSON flag or not.
  if (values["list-types"]) {
    const text = await coolify(["service", "create", "--list-types"], { ...options, json: false });
    const types = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith(":"));
    return {
      count: `${types.length} types`,
      types,
      help: [`Run \`${BIN} service create <type> --project-uuid <uuid> --server-uuid <uuid>\` to create one`],
    };
  }

  const type = required(
    positionals[0],
    "<type>",
    "service create",
    `${BIN} service create n8n --project-uuid <uuid> --server-uuid <uuid>`,
  );
  const projectUuid = required(
    values["project-uuid"],
    "--project-uuid",
    "service create",
    `${BIN} service create ${type} --project-uuid <uuid> --server-uuid <uuid>`,
  );
  const serverUuid = required(
    values["server-uuid"],
    "--server-uuid",
    "service create",
    `${BIN} service create ${type} --project-uuid ${projectUuid} --server-uuid <uuid>`,
  );
  if (values["environment-name"] && values["environment-uuid"]) {
    throw new AxiError("pass --environment-name or --environment-uuid, not both", "VALIDATION_ERROR", [
      `Example: ${BIN} service create ${type} --environment-name production`,
    ]);
  }

  const args = ["service", "create", type, "--project-uuid", projectUuid, "--server-uuid", serverUuid];
  if (values["environment-name"]) args.push("--environment-name", values["environment-name"]);
  if (values["environment-uuid"]) args.push("--environment-uuid", values["environment-uuid"]);
  if (values.name) args.push("--name", values.name);
  if (values.description) args.push("--description", values.description);
  if (values["docker-compose"]) args.push("--docker-compose", values["docker-compose"]);
  if (values["instant-deploy"]) args.push("--instant-deploy");
  // Mutations answer with a plain-text confirmation, not JSON.
  await coolify(args, { ...options, json: false });

  return {
    created: type,
    ...(values.name ? { name: values.name } : {}),
    ...(values["instant-deploy"] ? { deploying: true } : {}),
    help: [
      `Run \`${BIN} service list\` to see the new service and its uuid`,
      ...(values["instant-deploy"]
        ? []
        : [`Run \`${BIN} service start ${values.name ?? type}\` to deploy it`]),
    ],
  };
}

async function remove(argv) {
  if (wantsHelp(argv)) return HELP.delete;
  const { values, positionals } = parse(argv, {
    command: "service delete",
    flags: { yes: { type: "boolean" } },
  });
  const selector = required(positionals[0], "<name|uuid>", "service delete", `${BIN} service delete cAdvisor --yes`);
  const options = { context: values.context };

  const rows = await coolify(["service", "list"], options);
  const found = matchOrRaise(rows, selector, "service");

  // Deletion also removes volumes, networks, and configurations — one resolved
  // typo must not destroy a live service, so it stays opt-in.
  if (!values.yes) {
    throw new AxiError(`pass --yes to delete service ${found.name} (${found.uuid})`, "VALIDATION_ERROR", [
      `That would remove ${found.name} plus its volumes, networks, and configurations`,
      `Run \`${BIN} service delete ${found.name} --yes\` to delete it`,
    ]);
  }
  // --force skips the raw CLI's interactive prompt; this wrapper never prompts.
  await coolify(["service", "delete", found.uuid, "--force"], { ...options, json: false });
  return { deleted: found.name, uuid: found.uuid };
}

/** start/stop are declarative: already in the target state is a no-op, not an error. */
function stateChanger(action, desired) {
  return async function change(argv) {
    if (wantsHelp(argv)) return HELP.start;
    const { values, positionals } = parse(argv, { command: `service ${action}` });
    const selector = required(
      positionals[0],
      "<name|uuid>",
      `service ${action}`,
      `${BIN} service ${action} cAdvisor`,
    );
    const options = { context: values.context };

    const rows = await coolify(["service", "list"], options);
    const found = matchOrRaise(rows, selector, "service");
    const state = health(found.status).state;

    if (desired && state === desired) {
      return { service: found.name, state, unchanged: true, note: `already ${desired} (no-op)` };
    }
    await coolify(["service", action, found.uuid], options);
    return {
      service: found.name,
      action,
      previous: state,
      help: [`Run \`${BIN} service get ${found.name}\` to confirm the new state`],
    };
  };
}

async function env(argv) {
  if (wantsHelp(argv)) return HELP.env;
  const { values, positionals } = parse(argv, {
    command: "service env",
    flags: { reveal: { type: "boolean" }, set: { type: "string", multiple: true } },
  });
  const selector = required(positionals[0], "<name|uuid>", "service env", `${BIN} service env cAdvisor`);
  const options = { context: values.context };

  const rows = await coolify(["service", "list"], options);
  const found = matchOrRaise(rows, selector, "service");
  // The wrapped CLI masks values as `********` unless asked; --reveal has to
  // reach it, or it returns asterisks instead of the value.
  const vars = await coolify(
    ["service", "env", "list", found.uuid, ...(values.reveal ? ["--show-sensitive"] : [])],
    options,
  );
  const current = Array.isArray(vars) ? vars : [];

  if (values.set?.length) return await setEnv(found, current, values.set, options);

  if (current.length === 0) {
    return { service: found.name, env: `0 environment variables set on ${found.name}` };
  }
  return {
    service: found.name,
    count: `${current.length} total`,
    env: current.map((entry) => ({
      key: entry.key,
      value: redactValue(entry.key, entry.value, values.reveal),
      build_time: Boolean(entry.is_build_time),
    })),
    ...(values.reveal ? {} : { note: "values redacted; pass --reveal to print them" }),
  };
}

/**
 * Create or update each KEY=VALUE. Values are compared against the current set
 * so a re-run is a no-op, and are never echoed back — several of these are
 * secrets and the output is what an agent pastes into a summary.
 */
async function setEnv(found, rows, pairs, options) {
  const current = new Map(rows.map((entry) => [entry.key, entry.value]));
  const applied = [];

  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) {
      throw new AxiError(`--set ${pair} is not KEY=VALUE`, "VALIDATION_ERROR", [
        `Example: ${BIN} service env ${found.name} --set KEY=value`,
      ]);
    }
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);

    if (current.has(key) && current.get(key) === value) {
      applied.push({ key, unchanged: true });
      continue;
    }
    // The listing masks secrets as `********`, so an unchanged secret cannot be
    // detected by comparison — writing it again is the safe way round.
    const verb = current.has(key) ? "update" : "create";
    const args = current.has(key)
      ? ["service", "env", "update", found.uuid, key, "--value", value]
      : ["service", "env", "create", found.uuid, "--key", key, "--value", value];
    // These writes answer with a plain-text confirmation, not JSON, and the
    // payload is unused either way — parsing it would fail a successful write.
    await coolify(args, { ...options, json: false });
    applied.push({ key, [verb === "update" ? "updated" : "created"]: true });
  }

  return {
    service: found.name,
    env: applied,
    help: [`Run \`${BIN} service restart ${found.name}\` — env changes apply on restart`],
  };
}

export const serviceCommand = makeDispatcher(
  "service",
  {
    list,
    get,
    create,
    delete: remove,
    start: stateChanger("start", "running"),
    stop: stateChanger("stop", "exited"),
    restart: stateChanger("restart", null),
    env,
  },
  {
    fallback: "list",
    summary: {
      list: "List one-click services",
      get: "Show one service by name or uuid",
      create: "Create a service from a template type (--list-types to enumerate)",
      delete: "Delete a service (requires --yes)",
      start: "Start a service (idempotent)",
      stop: "Stop a service (idempotent)",
      restart: "Restart a service",
      env: "List a service's environment variables, or set them with --set",
    },
  },
);
