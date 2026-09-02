import { coolify, resolveResource } from "../coolify.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const HELP = {
  run: helpFor({
    command: "deploy run",
    description: "Trigger a deployment for an application or service, by name or uuid",
    usage: `${BIN} deploy run <name|uuid> [--force] [--docker-tag <tag>]`,
    flags: {
      "--force": "Rebuild without using the layer cache",
      "--docker-tag": "Override the image tag for this deployment",
    },
    examples: [`${BIN} deploy run digivaley`, `${BIN} deploy run digivaley --force`],
  }),
  list: helpFor({
    command: "deploy list",
    description: "List in-flight and recent deployments across the instance",
    usage: `${BIN} deploy list [--limit <n>]`,
    flags: { "--limit": "Maximum deployments to return (default 20)" },
    examples: [`${BIN} deploy list`],
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
      help: [`Run \`${BIN} deploy run <name>\` to start one`],
    };
  }
  return {
    count: `${Math.min(rows.length, limit)} of ${rows.length} total`,
    deployments: rows.slice(0, limit).map(row),
  };
}

async function run(argv) {
  if (wantsHelp(argv)) return HELP.run;
  const { values, positionals } = parse(argv, {
    command: "deploy run",
    flags: { force: { type: "boolean" }, "docker-tag": { type: "string" } },
  });
  const selector = required(
    positionals[0],
    "<name|uuid>",
    "deploy run",
    `${BIN} deploy run digivaley`,
  );
  const options = { context: values.context };
  const found = await resolveResource(selector, options);

  const args = ["deploy", "uuid", found.uuid];
  if (values.force) args.push("--force");
  if (values["docker-tag"]) args.push("--docker-tag", values["docker-tag"]);
  const result = await coolify(args, options);

  const deployment = Array.isArray(result) ? result[0] : result;
  return {
    deploying: found.name,
    type: found.type,
    ...(deployment?.deployment_uuid ? { deployment: deployment.deployment_uuid } : {}),
    ...(deployment?.message ? { message: deployment.message } : {}),
    help: [
      `Run \`${BIN} deploy list\` to watch it progress`,
      `Run \`${BIN} app logs ${found.name}\` once it finishes`,
    ],
  };
}

const dispatch = makeDispatcher(
  "deploy",
  { run, list },
  {
    fallback: "list",
    summary: {
      run: "Trigger a deployment by name or uuid",
      list: "List in-flight and recent deployments",
    },
  },
);

/**
 * Deploying is the common case, so `deploy <name>` is accepted as shorthand for
 * `deploy run <name>` — anything that is not a known subcommand is a resource.
 */
export async function deployCommand(argv) {
  const [first] = argv;
  if (first && !first.startsWith("-") && first !== "run" && first !== "list") {
    return run(argv);
  }
  return dispatch(argv);
}
