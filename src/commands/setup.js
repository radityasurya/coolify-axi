import { AxiError } from "axi-sdk-js";
import {
  installSessionStartHooks,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
} from "axi-sdk-js";
import { BIN, helpFor, makeDispatcher, parse, wantsHelp } from "../args.js";

const MARKER = "coolify-axi";

const HELP = {
  hooks: helpFor({
    command: "setup hooks",
    description: "Install SessionStart hooks so agents see your deployments before acting",
    usage: `${BIN} setup hooks [--project]`,
    flags: { "--project": "Install into this repository instead of the user config" },
    examples: [`${BIN} setup hooks`, `${BIN} setup hooks --project`],
  }),
  status: helpFor({
    command: "setup status",
    description: "Report which agent session hooks are installed",
    usage: `${BIN} setup status [--project]`,
    examples: [`${BIN} setup status`],
  }),
  uninstall: helpFor({
    command: "setup uninstall",
    description: "Remove the session hooks this tool installed",
    usage: `${BIN} setup uninstall [--project]`,
    examples: [`${BIN} setup uninstall`],
  }),
};

function scopeOf(values) {
  return values.project ? { scope: "project", projectDir: process.cwd() } : { scope: "user" };
}

const SCOPE_FLAG = { project: { type: "boolean" } };

function statusRows(status) {
  return [
    { agent: "claude", installed: status.claude.installed, path: status.claude.path },
    { agent: "codex", installed: status.codex.installed, path: status.codex.path },
    { agent: "opencode", installed: status.opencode.installed, path: status.opencode.path },
  ];
}

async function hooks(argv) {
  if (wantsHelp(argv)) return HELP.hooks;
  const { values } = parse(argv, { command: "setup hooks", flags: SCOPE_FLAG });
  const scope = scopeOf(values);
  const problems = [];
  installSessionStartHooks({ marker: MARKER, ...scope, onError: (m) => problems.push(m) });
  const status = sessionStartHookStatus({ marker: MARKER, ...scope });
  return {
    scope: status.scope,
    hooks: statusRows(status),
    ...(status.codex.installed && !status.codex.userFeatureEnabled
      ? { note: `Codex needs [features].hooks = true in ${status.codex.userFeaturePath}` }
      : {}),
    ...(problems.length ? { warning: problems.join("; ") } : {}),
    help: ["Restart your agent session so the new hook takes effect"],
  };
}

async function status(argv) {
  if (wantsHelp(argv)) return HELP.status;
  const { values } = parse(argv, { command: "setup status", flags: SCOPE_FLAG });
  const result = sessionStartHookStatus({ marker: MARKER, ...scopeOf(values) });
  const installed = statusRows(result).filter((row) => row.installed);
  return {
    scope: result.scope,
    hooks: statusRows(result),
    ...(installed.length === 0
      ? { help: [`Run \`${BIN} setup hooks\` to install them`] }
      : { help: [`Run \`${BIN} setup uninstall\` to remove them`] }),
  };
}

async function uninstall(argv) {
  if (wantsHelp(argv)) return HELP.uninstall;
  const { values } = parse(argv, { command: "setup uninstall", flags: SCOPE_FLAG });
  const scope = scopeOf(values);
  const problems = [];
  uninstallSessionStartHooks({ marker: MARKER, ...scope, onError: (m) => problems.push(m) });
  const result = sessionStartHookStatus({ marker: MARKER, ...scope });
  return {
    scope: result.scope,
    hooks: statusRows(result),
    ...(problems.length ? { warning: problems.join("; ") } : {}),
  };
}

export const setupCommand = makeDispatcher(
  "setup",
  { hooks, status, uninstall },
  {
    summary: {
      hooks: "Install SessionStart hooks for Claude Code, Codex, and OpenCode",
      status: "Report which session hooks are installed",
      uninstall: "Remove the session hooks this tool installed",
    },
  },
);
