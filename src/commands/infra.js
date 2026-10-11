import { AxiError } from "axi-sdk-js";
import { api } from "../api.js";
import { coolify, health, matchOrRaise, summarize } from "../coolify.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

/** server is a thin list/get pair; service grew its own command file; project needs the API for env ids. */
function listGet({ noun, plural, subject, columns, detailFields }) {
  const HELP = {
    list: helpFor({
      command: `${noun} list`,
      description: `List ${plural}`,
      usage: `${BIN} ${noun} list [--context <name>]`,
      examples: [`${BIN} ${noun} list`],
    }),
    get: helpFor({
      command: `${noun} get`,
      description: `Show one ${subject} by name or uuid`,
      usage: `${BIN} ${noun} get <name|uuid>`,
      examples: [`${BIN} ${noun} get <name>`],
    }),
  };

  async function list(argv) {
    if (wantsHelp(argv)) return HELP.list;
    const { values } = parse(argv, { command: `${noun} list` });
    const rows = await coolify([subject, "list"], { context: values.context });

    if (rows.length === 0) return { [plural]: `0 ${plural} on this instance` };
    return {
      count: `${rows.length} total`,
      ...(rows[0].status ? { summary: summarize(rows) } : {}),
      [plural]: rows.map((item) => columns(item)),
      help: [`Run \`${BIN} ${noun} get <name>\` for details`],
    };
  }

  async function get(argv) {
    if (wantsHelp(argv)) return HELP.get;
    const { values, positionals } = parse(argv, { command: `${noun} get` });
    const selector = required(positionals[0], "<name|uuid>", `${noun} get`, `${BIN} ${noun} get <name>`);
    const options = { context: values.context };

    const rows = await coolify([subject, "list"], options);
    const found = matchOrRaise(rows, selector, subject);

    const detail = await coolify([subject, "get", found.uuid], options);
    return {
      [subject]: Object.fromEntries(
        detailFields
          .filter((field) => detail[field] !== undefined && detail[field] !== "")
          .map((field) => [field, detail[field]]),
      ),
    };
  }

  return makeDispatcher(
    noun,
    { list, get },
    {
      fallback: "list",
      summary: { list: `List ${plural}`, get: `Show one ${subject}` },
    },
  );
}

export const serverCommand = listGet({
  noun: "server",
  plural: "servers",
  subject: "server",
  columns: (item) => ({ name: item.name, ip: item.ip, user: item.user, uuid: item.uuid }),
  detailFields: ["name", "uuid", "ip", "user", "port", "description"],
});

const PROJECT_HELP = {
  list: helpFor({
    command: "project list",
    description: "List projects",
    usage: `${BIN} project list [--context <name>]`,
    examples: [`${BIN} project list`],
  }),
  get: helpFor({
    command: "project get",
    description: "Show one project and its environments (id, name, uuid)",
    usage: `${BIN} project get <name|uuid>`,
    examples: [`${BIN} project get blog`],
  }),
};

async function projectList(argv) {
  if (wantsHelp(argv)) return PROJECT_HELP.list;
  const { values } = parse(argv, { command: "project list" });
  const rows = await coolify(["project", "list"], { context: values.context });

  if (rows.length === 0) return { projects: "0 projects on this instance" };
  return {
    count: `${rows.length} total`,
    projects: rows.map((item) => ({ name: item.name, uuid: item.uuid })),
    help: [`Run \`${BIN} project get <name>\` for its environments`],
  };
}

async function projectGet(argv) {
  if (wantsHelp(argv)) return PROJECT_HELP.get;
  const { values, positionals } = parse(argv, { command: "project get" });
  const selector = required(positionals[0], "<name|uuid>", "project get", `${BIN} project get blog`);
  const options = { context: values.context };

  const found = matchOrRaise(await coolify(["project", "list"], options), selector, "project");
  // The wrapped CLI drops environment ids, and a service names its
  // environment only by id, so the detail comes from the API.
  const detail = await api("GET", `/projects/${found.uuid}`, undefined, options);
  const environments = (detail?.environments ?? []).map((env) => ({ id: env.id, name: env.name, uuid: env.uuid }));
  return {
    project: { name: found.name, uuid: found.uuid },
    environments: environments.length ? environments : `0 environments in ${found.name}`,
    help: [`Run \`${BIN} shared-env --project ${found.name}\` for its shared variable keys`],
  };
}

export const projectCommand = makeDispatcher(
  "project",
  { list: projectList, get: projectGet },
  {
    fallback: "list",
    summary: { list: "List projects", get: "Show one project and its environments" },
  },
);

const SHARED_ENV_HELP = helpFor({
  command: "shared-env list",
  description: "List shared variable keys at team, project, or environment scope; values are never printed",
  usage: `${BIN} shared-env [list] [--project <name|uuid> [--environment <name|uuid>]]`,
  flags: {
    "--project": "Project scope instead of team scope",
    "--environment": "Environment scope inside --project",
  },
  notes: "Each row carries the reference to store in a resource's env var, such as {{team.GH_RUNNER_TOKEN}}",
  examples: [`${BIN} shared-env`, `${BIN} shared-env --project blog --environment production`],
});

/** Keys only: the reference is what a resource stores, so a value is never needed. */
async function sharedEnvList(argv) {
  if (wantsHelp(argv)) return SHARED_ENV_HELP;
  const { values } = parse(argv, {
    command: "shared-env list",
    flags: { project: { type: "string" }, environment: { type: "string" } },
  });
  const options = { context: values.context };
  if (values.environment && !values.project) {
    throw new AxiError("--environment needs --project", "VALIDATION_ERROR", [
      `Example: ${BIN} shared-env --project <name> --environment ${values.environment}`,
    ]);
  }

  let scope = "team";
  let args = ["shared-env", "team", "list"];
  if (values.project) {
    const project = matchOrRaise(await coolify(["project", "list"], options), values.project, "project");
    scope = values.environment ? "environment" : "project";
    args = values.environment
      ? ["shared-env", "environment", "list", project.uuid, values.environment]
      : ["shared-env", "project", "list", project.uuid];
  }
  const rows = await coolify(args, options);
  const vars = Array.isArray(rows) ? rows : [];

  if (vars.length === 0) return { scope, variables: `0 ${scope} shared variables` };
  return {
    scope,
    count: `${vars.length} total`,
    variables: vars.map((row) => ({ key: row.key, ref: `{{${scope}.${row.key}}}` })),
    help: [`Run \`${BIN} service env <name> --set 'KEY={{${scope}.<key>}}'\` to point a variable at one`],
  };
}

export const sharedEnvCommand = makeDispatcher(
  "shared-env",
  { list: sharedEnvList },
  { fallback: "list", summary: { list: "List shared variable keys (team, --project, --environment)" } },
);
