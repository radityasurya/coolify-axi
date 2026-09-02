import { parseArgs } from "node:util";
import { AxiError } from "axi-sdk-js";

export const BIN = "coolify-axi";

// Always-allowed globals, per AXI §6: they pass on every command and are never
// reported as unknown.
const GLOBAL_FLAGS = {
  context: { type: "string" },
  help: { type: "boolean" },
};

const RENAMED = {
  instance: "--context",
  server: "--context",
  app: "--name",
};

/**
 * Strict parse for one subcommand. Unknown flags fail loud (exit 2) and the
 * error carries that subcommand's valid flags, so the agent self-corrects in
 * one turn instead of making a follow-up `--help` call.
 */
export function parse(argv, { command, flags = {} }) {
  const options = { ...GLOBAL_FLAGS, ...flags };
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });
    return { values, positionals };
  } catch (error) {
    throw usageError(error, command, options);
  }
}

function usageError(error, command, options) {
  const valid = Object.keys(options)
    .map((name) => `--${name}`)
    .join(", ");
  const raw = String(error.message);
  const unknown = raw.match(/'?(--?[\w-]+)'?/)?.[1];

  if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const bare = unknown?.replace(/^--?/, "");
    const replacement = bare && RENAMED[bare];
    return new AxiError(`unknown flag ${unknown} for \`${command}\``, "VALIDATION_ERROR", [
      replacement
        ? `${unknown} was renamed; use ${replacement} instead`
        : `valid flags for \`${command}\`: ${valid}`,
    ]);
  }
  if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return new AxiError(raw, "VALIDATION_ERROR", [
      `Pass a value: \`${BIN} ${command} ${unknown ?? "--flag"} <value>\``,
    ]);
  }
  return new AxiError(raw, "VALIDATION_ERROR", [`valid flags for \`${command}\`: ${valid}`]);
}

export function required(value, name, command, example) {
  if (value === undefined || value === null || value === "") {
    throw new AxiError(`${name} is required`, "VALIDATION_ERROR", [example]);
  }
  return value;
}

/** Positive-integer flag values, so `--limit abc` fails before any API call. */
export function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AxiError(`${name} must be a positive integer`, "VALIDATION_ERROR", [
      `Example: ${name} 20`,
    ]);
  }
  return parsed;
}

/** Concise per-subcommand reference (AXI §10). */
export function helpFor({ command, description, usage, flags, examples }) {
  return {
    command,
    description,
    ...(usage ? { usage } : {}),
    ...(flags && Object.keys(flags).length ? { flags } : {}),
    ...(examples?.length ? { examples } : {}),
  };
}

export function wantsHelp(argv) {
  return argv.includes("--help");
}

/**
 * Shared subcommand dispatch for the grouped nouns (`zone`, `dns`, `cache`,
 * `email`). Flags in the first position fall through to the group's default
 * subcommand, so `dns --type A` behaves like `dns list --type A`.
 */
export function makeDispatcher(group, handlers, { fallback, summary }) {
  const groupHelp = {
    command: group,
    subcommands: summary,
    help: [`Run \`${BIN} ${group} <subcommand> --help\` for a subcommand reference`],
  };
  return async function dispatch(argv) {
    const [subcommand, ...rest] = argv;
    if (subcommand === undefined || subcommand.startsWith("-")) {
      if (wantsHelp(argv)) return groupHelp;
      if (fallback) return handlers[fallback](argv);
      return groupHelp;
    }
    const handler = handlers[subcommand];
    if (!handler) {
      throw new AxiError(`unknown subcommand \`${group} ${subcommand}\``, "VALIDATION_ERROR", [
        `valid subcommands: ${Object.keys(handlers).join(", ")}`,
        `Run \`${BIN} ${group} --help\``,
      ]);
    }
    return handler(rest);
  };
}
