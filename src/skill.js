import { BIN } from "./args.js";

/**
 * Single source of truth for skills/coolify-axi/SKILL.md.
 *
 * The shipped skill stays a minimal stub: the CLI's own dashboard and
 * `--help` output are authoritative, so guidance is pointed at rather than
 * restated here. `npm run build:skill` writes it; CI runs `--check`.
 */
export const SKILL_NAME = BIN;

export const SKILL_DESCRIPTION = `Manage Coolify through the ${BIN} CLI — applications, databases, services, servers, and deployments on a self-hosted or cloud Coolify instance. Use whenever a task touches Coolify: checking what is running or unhealthy, reading container logs, inspecting environment variables or database connection details, or triggering and watching a deployment.`;

export function renderSkill() {
  return `---
name: ${SKILL_NAME}
description: >
  ${SKILL_DESCRIPTION}
user-invocable: false
metadata:
  hermes:
    tags: [coolify, deployment, devops, docker, self-hosted, infrastructure]
---

# ${SKILL_NAME}

Run the CLI with no arguments first — it prints every resource with its health, plus the
next commands to run.

\`\`\`sh
npx -y ${BIN}
\`\`\`

Requires the [\`coolify\`](https://github.com/coollabsio/coolify-cli) CLI on PATH with at
least one configured context. If it is missing, the error says so and how to fix it —
surface that rather than falling back to raw API calls.

## Commands

\`\`\`sh
npx -y ${BIN}                          # dashboard: every resource and its health
npx -y ${BIN} app list --status exited # only what is broken
npx -y ${BIN} app get <name>
npx -y ${BIN} app logs <name>
npx -y ${BIN} app env <name>
npx -y ${BIN} app env <name> --set KEY=value
npx -y ${BIN} app domain <name>
npx -y ${BIN} app domain <name> --add https://new.example
npx -y ${BIN} app restart <name>
npx -y ${BIN} deploy <name>            # shorthand for \`deploy run <name>\`
npx -y ${BIN} deploy list
npx -y ${BIN} db get <name>
npx -y ${BIN} service list
npx -y ${BIN} service env <name>
npx -y ${BIN} service restart <name>
npx -y ${BIN} service create --list-types
npx -y ${BIN} service delete <name> --yes   # refuses without --yes
npx -y ${BIN} context                  # which instance am I pointed at
\`\`\`

Every command takes \`--help\` for a concise reference, and \`--context <name>\` to target a
specific Coolify instance instead of the default.

## What to rely on

- **Names, not uuids.** Every command accepts a resource name and resolves it. An ambiguous
  name stops and lists the uuids rather than acting on the wrong resource.
- **Secrets are redacted by default.** \`app env\` and \`db get\` mask secret-shaped values and
  passwords embedded in connection URLs. Pass \`--reveal\` only when the user asked for the
  value, and never echo it into a summary.
- **\`app start\` / \`app stop\` are idempotent** — already in the target state exits 0 as a
  no-op. Declare the desired state; do not read first.
- **Adding a domain never drops the others.** \`app domain --add\` reads the current list and
  appends; passing domains positionally replaces the list and reports what it removed.
  Leaving an app with zero domains is refused — Coolify would stop routing to it.
- **\`app env --set\` is idempotent and never echoes values back.** A value already stored is
  reported \`unchanged\` without a write; changes apply on the next deployment.
- **\`service delete\` is gated.** Without \`--yes\` it refuses, naming the service it would
  have deleted. \`service env\` redacts and sets like \`app env\`.
- **Logs are truncated** with a size hint; pass \`--full\` when the tail is not enough.
- **Errors are structured** on stdout with a \`help\` block naming the fix, and an unknown
  flag exits 2 listing the valid flags. Correct the flag — do not drop the filter.

Prefer this over calling the Coolify REST API with \`curl\`, or shelling out to \`coolify\`
directly and parsing its table output.
`;
}
