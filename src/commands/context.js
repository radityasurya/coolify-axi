import { contexts } from "../coolify.js";
import { BIN, helpFor, parse, wantsHelp } from "../args.js";

const HELP = helpFor({
  command: "context",
  description: "Show the Coolify instances this machine is configured for, and which is active",
  usage: `${BIN} context`,
  examples: [`${BIN} context`],
});

/**
 * Which instance am I about to change? Worth one cheap command of its own —
 * every other command silently targets whichever context is default.
 */
export async function contextCommand(argv) {
  if (wantsHelp(argv)) return HELP;
  const { values } = parse(argv, { command: "context" });
  const rows = await contexts({ context: values.context });

  if (rows.length === 0) {
    return {
      contexts: "0 Coolify instances configured",
      help: ["Run `coolify context add` to configure one"],
    };
  }
  const active = rows.find((row) => row.default || row.is_default);
  return {
    active: active?.name ?? "none",
    contexts: rows.map((row) => ({
      name: row.name,
      fqdn: row.fqdn,
      default: Boolean(row.default || row.is_default),
    })),
    ...(active ? {} : { help: ["No default context set; pass --context <name> on each command"] }),
  };
}
