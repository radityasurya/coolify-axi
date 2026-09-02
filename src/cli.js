import { runAxiCli } from "axi-sdk-js";
// The SDK renders command output itself but does not re-export its encoder,
// so the static top-level help encodes through the same official TOON library.
import { encode } from "@toon-format/toon";
import { BIN } from "./args.js";
import { coolify, currentContext, health, summarize } from "./coolify.js";
import { appCommand } from "./commands/app.js";
import { contextCommand } from "./commands/context.js";
import { dbCommand } from "./commands/db.js";
import { deployCommand } from "./commands/deploy.js";
import { serverCommand, serviceCommand } from "./commands/infra.js";
import { setupCommand } from "./commands/setup.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Manage Coolify applications, databases, services, and deployments";

export const TOP_HELP = `${encode({
  usage: `${BIN} [command] [args] [flags]`,
  commands: {
    "(none)": "dashboard — every resource and its health",
    app: "list, get, logs, env, start, stop, restart",
    db: "list, get",
    service: "list, get",
    server: "list, get",
    deploy: "run, list",
    context: "show configured Coolify instances",
    setup: "hooks, status, uninstall",
  },
  globals: { "--context": "Target a named Coolify instance instead of the default" },
  requires: "the `coolify` CLI, configured with at least one context",
  examples: [
    BIN,
    `${BIN} app logs digivaley`,
    `${BIN} deploy digivaley`,
    `${BIN} db get blogs-pg`,
    `${BIN} app list --status exited`,
  ],
  help: [`Run \`${BIN} <command> --help\` for a command reference`],
})}\n`;

/**
 * AXI §8: no-args shows live state. `resource list` already returns exactly the
 * four fields worth showing, so the dashboard is one call plus a state rollup.
 */
async function home(argv) {
  const context = await currentContext().catch(() => undefined);
  const resources = await coolify(["resource", "list"], {});

  if (resources.length === 0) {
    return {
      ...(context ? { context } : {}),
      resources: "0 resources on this Coolify instance",
      help: [`Run \`${BIN} context\` to check which instance is targeted`],
    };
  }

  const unhealthy = resources.filter((item) => health(item.status).state !== "running");
  return {
    ...(context ? { context } : {}),
    count: `${resources.length} total`,
    summary: summarize(resources),
    resources: resources.map((item) => ({
      name: item.name,
      type: item.type,
      state: health(item.status).state,
    })),
    help: [
      ...(unhealthy.length
        ? [`Run \`${BIN} app logs ${unhealthy[0].name}\` — ${unhealthy.length} not running`]
        : []),
      `Run \`${BIN} app get <name>\` for a resource's domain, repo, and build pack`,
      `Run \`${BIN} deploy <name>\` to trigger a deployment`,
      `Run \`${BIN} db get <name>\` for connection details`,
    ],
  };
}

export async function main() {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home,
    commands: {
      app: appCommand,
      db: dbCommand,
      service: serviceCommand,
      server: serverCommand,
      deploy: deployCommand,
      context: contextCommand,
      setup: setupCommand,
    },
  });
}
