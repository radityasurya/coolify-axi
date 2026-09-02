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
npx -y ${BIN} app restart <name>
npx -y ${BIN} deploy <name>            # shorthand for \`deploy run <name>\`
npx -y ${BIN} deploy list
npx -y ${BIN} db get <name>
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
- **Logs are truncated** with a size hint; pass \`--full\` when the tail is not enough.
- **Errors are structured** on stdout with a \`help\` block naming the fix, and an unknown
  flag exits 2 listing the valid flags. Correct the flag — do not drop the filter.

Prefer this over calling the Coolify REST API with \`curl\`, or shelling out to \`coolify\`
directly and parsing its table output.
`;
}
