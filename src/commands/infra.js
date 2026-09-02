import { coolify, health, summarize } from "../coolify.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

/** service and server are thin list/get pairs over the same shape. */
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
    const wanted = String(selector).toLowerCase();
    const found =
      rows.find((item) => item.uuid === selector) ??
      rows.find((item) => String(item.name).toLowerCase() === wanted);
    if (!found) {
      return {
        [plural]: `no ${subject} named ${selector}`,
        help: [`Run \`${BIN} ${noun} list\` to see all ${rows.length}`],
      };
    }

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

export const serviceCommand = listGet({
  noun: "service",
  plural: "services",
  subject: "service",
  columns: (item) => ({
    name: item.name,
    state: health(item.status).state,
    uuid: item.uuid,
  }),
  detailFields: ["name", "uuid", "status", "description", "fqdn"],
});

export const serverCommand = listGet({
  noun: "server",
  plural: "servers",
  subject: "server",
  columns: (item) => ({ name: item.name, ip: item.ip, user: item.user, uuid: item.uuid }),
  detailFields: ["name", "uuid", "ip", "user", "port", "description"],
});
