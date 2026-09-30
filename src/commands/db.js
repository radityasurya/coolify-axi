import { coolify, health, matchOrRaise, pick, redact, resolvePlacement, summarize } from "../coolify.js";
import { AxiError } from "axi-sdk-js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const TYPE_PREFIX = ["postgresql", "mysql", "mariadb", "mongodb", "redis", "keydb", "dragonfly", "clickhouse"];

const HELP = {
  list: helpFor({
    command: "db list",
    description: "List databases with engine and health",
    usage: `${BIN} db list [--context <name>]`,
    examples: [`${BIN} db list`],
  }),
  get: helpFor({
    command: "db get",
    description: "Show one database; connection secrets are redacted by default",
    usage: `${BIN} db get <name|uuid> [--reveal]`,
    flags: { "--reveal": "Print passwords and connection strings in clear text" },
    examples: [`${BIN} db get blogs-pg`, `${BIN} db get blogs-pg --reveal`],
  }),
  create: helpFor({
    command: "db create",
    description: "Create a database; Coolify generates the password, and it is never printed",
    usage:
      `${BIN} db create postgres|redis <name> --server <name|uuid> --project <name|uuid> ` +
      `[--environment <name>] [--image <image>] [--public-port <n>] [--instant-deploy]`,
    flags: {
      "--environment": "Environment name (default production)",
      "--image": "Image and tag, for example postgres:18",
      "--public-port": "Expose the database on this host port (makes it public)",
      "--instant-deploy": "Start it right after creating",
    },
    examples: [`${BIN} db create postgres blogs-pg --server localhost --project blog --instant-deploy`],
  }),
};

const DETAIL_FIELDS = [
  "name",
  "uuid",
  "status",
  "type",
  "image",
  "is_public",
  "public_port",
  "postgres_user",
  "postgres_db",
  "postgres_password",
  "internal_db_url",
  "external_db_url",
];

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "db list" });
  const options = { context: values.context };
  const rows = await coolify(["database", "list"], options);

  if (rows.length === 0) {
    return { databases: "0 databases on this instance" };
  }
  return {
    count: `${rows.length} total`,
    summary: summarize(rows),
    databases: rows.map((item) => ({
      name: item.name,
      engine: item.type,
      state: health(item.status).state,
      uuid: item.uuid,
    })),
    help: [`Run \`${BIN} db get <name>\` for connection details (secrets redacted)`],
  };
}

async function get(argv) {
  if (wantsHelp(argv)) return HELP.get;
  const { values, positionals } = parse(argv, {
    command: "db get",
    flags: { reveal: { type: "boolean" } },
  });
  const selector = required(positionals[0], "<name|uuid>", "db get", `${BIN} db get blogs-pg`);
  const options = { context: values.context };

  // Databases are not in `resource list` under a single type, so match the
  // database listing directly rather than through resolveResource.
  const rows = await coolify(["database", "list"], options);
  const found = matchOrRaise(rows, selector, "database");

  const detail = await coolify(
    ["database", "get", found.uuid, ...(values.reveal ? ["--show-sensitive"] : [])],
    options,
  );
  const projected = Object.fromEntries(
    DETAIL_FIELDS.filter((field) => detail[field] !== undefined && detail[field] !== "").map(
      (field) => [field, detail[field]],
    ),
  );

  return {
    database: redact(projected, values.reveal),
    ...(values.reveal ? {} : { note: "secrets redacted; pass --reveal to print them" }),
  };
}

const ENGINES = { postgres: "postgresql", redis: "redis" };

async function create(argv) {
  if (wantsHelp(argv)) return HELP.create;
  const { values, positionals } = parse(argv, {
    command: "db create",
    flags: {
      server: { type: "string" },
      project: { type: "string" },
      environment: { type: "string" },
      image: { type: "string" },
      "public-port": { type: "string" },
      "instant-deploy": { type: "boolean" },
    },
  });
  const example = `${BIN} db create postgres blogs-pg --server localhost --project blog`;
  const engine = required(positionals[0], "<postgres|redis>", "db create", example);
  if (!(engine in ENGINES)) {
    throw new AxiError(`unsupported engine ${engine}`, "VALIDATION_ERROR", [`valid engines: ${Object.keys(ENGINES).join(", ")}`]);
  }
  const name = required(positionals[1], "<name>", "db create", example);
  for (const flag of ["server", "project"]) required(values[flag], `--${flag}`, "db create", example);
  const publicPort = values["public-port"] === undefined ? undefined : positiveInt(values["public-port"], "--public-port");
  const options = { context: values.context };

  const placement = await resolvePlacement(values, options);
  // No password flags on purpose: Coolify generates one and it stays server-side.
  const created = await coolify(
    [
      "database", "create", ENGINES[engine], ...placement, "--name", name,
      ...(values.image ? ["--image", values.image] : []),
      ...(publicPort ? ["--is-public", "--public-port", String(publicPort)] : []),
      ...(values["instant-deploy"] ? ["--instant-deploy"] : []),
    ],
    options,
  );
  return {
    created: { type: engine, name, ...pick(created, ["uuid", "status"]) },
    help: [
      `Run \`${BIN} db get ${name}\` for state; add --reveal to print the generated password and URLs`,
      `Run \`${BIN} db list\` to see every database`,
    ],
  };
}

export const dbCommand = makeDispatcher(
  "db",
  { list, get, create },
  {
    fallback: "list",
    summary: {
      list: "List databases with engine and health",
      get: "Show one database (secrets redacted)",
      create: "Create a postgres or redis database (password generated, never printed)",
    },
  },
);

export const DB_ENGINES = TYPE_PREFIX;
