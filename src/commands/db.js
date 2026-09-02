import { coolify, health, redact, resolveResource, summarize } from "../coolify.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

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
  const wanted = String(selector).toLowerCase();
  const found =
    rows.find((item) => item.uuid === selector) ??
    rows.find((item) => String(item.name).toLowerCase() === wanted);
  if (!found) {
    const near = rows
      .filter((item) => String(item.name).toLowerCase().includes(wanted))
      .slice(0, 5)
      .map((item) => `Run with ${item.name}`);
    return {
      databases: `no database named ${selector}`,
      help: [...near, `Run \`${BIN} db list\` to see all ${rows.length}`],
    };
  }

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

export const dbCommand = makeDispatcher(
  "db",
  { list, get },
  {
    fallback: "list",
    summary: {
      list: "List databases with engine and health",
      get: "Show one database (secrets redacted)",
    },
  },
);

export const DB_ENGINES = TYPE_PREFIX;
