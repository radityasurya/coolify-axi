import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { api } from "../api.js";
import { coolify, health, maskEnvValue, matchOrRaise, pick, summarize } from "../coolify.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";
import { redactCompose } from "../logs.js";

// The API detail carries the compose source and, for a read:sensitive token,
// the destination's server with its settings; the view is an allow-list.
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
    description:
      "Show one service: state, project and environment, server and destination uuids, and its env var keys",
    usage: `${BIN} service get <name|uuid>`,
    notes: "server_uuid and destination_uuid appear only when the API token has the read:sensitive ability",
    examples: [`${BIN} service get cAdvisor`],
  }),
  compose: helpFor({
    command: "service compose",
    description: "Print a service's Docker Compose source with secret values redacted",
    usage: `${BIN} service compose <name|uuid>`,
    notes:
      "Values under keys containing TOKEN, SECRET, KEY, PASS, PAT or CREDENTIAL are masked, as are GitHub tokens " +
      "and credentialed URLs. ${VAR} interpolations and {{team.X}} references stay visible. There is no --reveal.",
    examples: [`${BIN} service compose cAdvisor`],
  }),
  create: helpFor({
    command: "service create",
    description: "Create a service from a one-click template type or from your own Docker Compose file",
    usage:
      `${BIN} service create <type>|--docker-compose-file <path> --project-uuid <uuid> --server-uuid <uuid> ` +
      `[--destination-uuid <uuid>] [--environment-name <name>|--environment-uuid <uuid>] [--name <name>] ` +
      `[--description <text>] [--instant-deploy]`,
    flags: {
      "--project-uuid": "Project to create the service in (required; `project list` shows them)",
      "--server-uuid": "Server to create the service on (required)",
      "--destination-uuid": "Docker network destination; required when the server has more than one",
      "--environment-name": "Environment by name; production when neither environment flag is given",
      "--environment-uuid": "Environment by uuid; replaces --environment-name",
      "--name": "Service name",
      "--description": "Service description",
      "--docker-compose-file": "Read the Docker Compose source from this file; replaces <type>",
      "--docker-compose": "Docker Compose source given inline; replaces <type>",
      "--instant-deploy": "Deploy immediately after creation",
      "--list-types": "Print every valid <type> instead of creating anything",
    },
    examples: [
      `${BIN} service create --list-types`,
      `${BIN} service create n8n --project-uuid <uuid> --server-uuid <uuid> --environment-name production`,
      `${BIN} service create --docker-compose-file compose.yml --name runner-2 --project-uuid <uuid> --server-uuid <uuid> --destination-uuid <uuid>`,
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
      "--reveal": "Print every value in clear text; without it only shared-variable references such as {{team.X}} show",
      "--set": "KEY=VALUE to create or update, repeatable; values are never echoed back",
    },
    examples: [
      `${BIN} service env cAdvisor`,
      `${BIN} service env cAdvisor --set N8N_HOST=https://n8n.example`,
      `${BIN} service env runner-2 --set 'ACCESS_TOKEN={{team.GH_RUNNER_TOKEN}}'`,
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

  // The wrapped CLI drops environment_id and the destination, so the detail
  // comes from the API. A service names its environment only by id; the
  // project tree maps it back to names and uuids.
  const [detail, tree, vars] = await Promise.all([
    api("GET", `/services/${found.uuid}`, undefined, options),
    projectTree(options),
    coolify(["service", "env", "list", found.uuid], options),
  ]);
  const place = locate(tree, detail?.environment_id);
  const fields = {
    ...pick(detail, DETAIL_FIELDS),
    project: place?.project.name,
    project_uuid: place?.project.uuid,
    environment: place?.environment.name,
    environment_uuid: place?.environment.uuid,
    server_uuid: detail?.destination?.server?.uuid,
    destination_uuid: detail?.destination?.uuid,
  };
  const keys = (Array.isArray(vars) ? vars : []).map((entry) => entry.key);
  return {
    service: {
      ...pick(fields, Object.keys(fields)),
      env_keys: keys.length ? keys : "0 environment variables",
    },
    ...(fields.server_uuid ? {} : { note: "server_uuid and destination_uuid need an API token with the read:sensitive ability" }),
    help: [`Run \`${BIN} service compose ${found.name}\` for its Docker Compose source, secrets redacted`],
  };
}

/** Every project with its environments (id, name, uuid). */
async function projectTree(options) {
  const projects = await coolify(["project", "list"], options);
  return Promise.all(projects.map((project) => api("GET", `/projects/${project.uuid}`, undefined, options)));
}

function locate(tree, environmentId) {
  for (const project of tree) {
    const environment = (project?.environments ?? []).find((env) => env.id === environmentId);
    if (environment) return { project, environment };
  }
  return undefined;
}

async function compose(argv) {
  if (wantsHelp(argv)) return HELP.compose;
  const { values, positionals } = parse(argv, { command: "service compose" });
  const selector = required(positionals[0], "<name|uuid>", "service compose", `${BIN} service compose cAdvisor`);
  const options = { context: values.context };

  const found = matchOrRaise(await coolify(["service", "list"], options), selector, "service");
  const detail = await api("GET", `/services/${found.uuid}`, undefined, options);
  if (!detail?.docker_compose_raw) {
    throw new AxiError(`Coolify returned no compose for ${found.name}`, "AUTH_ERROR", [
      "The API shows compose only to a token with the read:sensitive ability; create one in the Coolify dashboard",
    ]);
  }
  return {
    service: found.name,
    compose: redactCompose(detail.docker_compose_raw),
    note: "secret values redacted; ${VAR} and {{team.X}} references kept",
    help: [
      `To clone it, save the compose to a file, then run \`${BIN} service create --docker-compose-file <path> ` +
        `--name <new-name> --project-uuid <uuid> --environment-uuid <uuid> --server-uuid <uuid> --destination-uuid <uuid>\` ` +
        `(uuids from \`${BIN} service get ${found.name}\`)`,
    ],
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
      "destination-uuid": { type: "string" },
      "docker-compose": { type: "string" },
      "docker-compose-file": { type: "string" },
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

  const type = positionals[0];
  const example = `${BIN} service create --docker-compose-file compose.yml --project-uuid <uuid> --server-uuid <uuid>`;
  if (values["docker-compose"] !== undefined && values["docker-compose-file"]) {
    throw new AxiError("pass --docker-compose or --docker-compose-file, not both", "VALIDATION_ERROR", [example]);
  }
  const source = values["docker-compose-file"] ? readCompose(values["docker-compose-file"]) : values["docker-compose"];
  // Coolify refuses a body that carries both a template type and a compose.
  if (type && source !== undefined) {
    throw new AxiError("pass a <type> or a compose, not both", "VALIDATION_ERROR", [
      `A template: ${BIN} service create ${type} --project-uuid <uuid> --server-uuid <uuid>`,
      `Your own compose: ${example}`,
    ]);
  }
  if (!type && source === undefined) {
    throw new AxiError("<type> or --docker-compose-file is required", "VALIDATION_ERROR", [
      example,
      `Run \`${BIN} service create --list-types\` for the template types`,
    ]);
  }
  if (source !== undefined && !source.trim()) {
    throw new AxiError("the compose is empty", "VALIDATION_ERROR", [example]);
  }
  const projectUuid = required(values["project-uuid"], "--project-uuid", "service create", example);
  const serverUuid = required(values["server-uuid"], "--server-uuid", "service create", example);
  if (values["environment-name"] && values["environment-uuid"]) {
    throw new AxiError("pass --environment-name or --environment-uuid, not both", "VALIDATION_ERROR", [
      `Example: ${BIN} service create ${type ?? "<type>"} --environment-name production`,
    ]);
  }

  // The API, not the wrapped CLI: the CLI sends `docker_compose` and
  // `environment`, which Coolify rejects, and cannot create without a type.
  const body = {
    ...(type ? { type } : { docker_compose_raw: Buffer.from(source).toString("base64") }),
    project_uuid: projectUuid,
    server_uuid: serverUuid,
    ...(values["destination-uuid"] ? { destination_uuid: values["destination-uuid"] } : {}),
    ...(values["environment-uuid"]
      ? { environment_uuid: values["environment-uuid"] }
      : { environment_name: values["environment-name"] ?? "production" }),
    ...(values.name ? { name: values.name } : {}),
    ...(values.description ? { description: values.description } : {}),
    instant_deploy: Boolean(values["instant-deploy"]),
  };
  const created = await api("POST", "/services", body, options);
  const uuid = created?.uuid;
  const domains = Array.isArray(created?.domains) ? created.domains : [];

  return {
    created: type ?? "custom compose",
    ...(values.name ? { name: values.name } : {}),
    ...(uuid ? { uuid } : {}),
    ...(domains.length ? { domains } : {}),
    ...(values["instant-deploy"] ? { deploying: true } : {}),
    help: [
      `Run \`${BIN} service env ${uuid ?? "<uuid>"} --set KEY=VALUE\` to set its variables`,
      ...(values["instant-deploy"] ? [] : [`Run \`${BIN} service start ${uuid ?? "<uuid>"}\` to deploy it`]),
    ],
  };
}

function readCompose(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new AxiError(`cannot read --docker-compose-file ${path} (${error.code ?? "unreadable"})`, "VALIDATION_ERROR", [
      "Pass the path to a Docker Compose YAML file",
    ]);
  }
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
    // The wrapped CLI answers with a plain-text message, not JSON.
    await coolify(["service", action, found.uuid], { ...options, json: false });
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
  // Fetched in clear even without --reveal: the wrapped CLI would turn a
  // shared-variable reference into `********`. maskEnvValue masks the rest.
  const vars = await coolify(["service", "env", "list", found.uuid, "--show-sensitive"], options);
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
      value: maskEnvValue(entry.value, values.reveal),
      build_time: Boolean(entry.is_build_time),
    })),
    ...(values.reveal ? {} : { note: "values redacted except shared-variable references; pass --reveal to print them" }),
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
    compose,
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
      get: "Show one service: project, environment, server, destination, env keys",
      compose: "Print a service's Docker Compose source, secrets redacted",
      create: "Create a service from a template type or a compose file (--list-types to enumerate)",
      delete: "Delete a service (requires --yes)",
      start: "Start a service (idempotent)",
      stop: "Stop a service (idempotent)",
      restart: "Restart a service",
      env: "List a service's environment variables, or set them with --set",
    },
  },
);
