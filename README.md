<h1 align="center">coolify-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/coolify-axi"><img alt="npm" src="https://img.shields.io/npm/v/coolify-axi?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square" /></a>
  <a href="https://axi.md"><img alt="AXI" src="https://img.shields.io/badge/built%20with-AXI-black?style=flat-square" /></a>
</p>

<h3 align="center">Coolify CLI for agents.</h3>

Manage [Coolify](https://coolify.io) applications, databases, services, and deployments
from the shell — designed with [AXI](https://axi.md) (Agent eXperience Interface).

Wraps the official [`coolify`](https://github.com/coollabsio/coolify-cli) CLI with
token-efficient TOON output, name-based addressing, redacted secrets, and contextual
next-step suggestions.

## Why

Agent ergonomics is measurable. On a real Coolify instance with 19 resources:

| Command | Raw `coolify --format json` | `coolify-axi` | Reduction |
| --- | --- | --- | --- |
| `app list` | 30,873 B | 764 B | **40×** |
| `db list` | 2,664 B | 491 B | 5.4× |

The `app list` gap is not a rounding artifact: Coolify returns ~40 fields per application,
including base64-encoded Traefik labels and the full Dockerfile and compose paths. An agent
needs four of them to decide what to do next.

Beyond size, the wrapped CLI addresses every resource by uuid. `coolify-axi` takes names,
so `coolify-axi app logs digivaley` replaces a list-then-grep-then-call round trip.

## Quick Start

Install the skill in the [Agent Skills](https://agentskills.io) format with
[`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add radityasurya/coolify-axi --skill coolify-axi -g
```

That is the entire setup — no npm install needed. The skill is a minimal discovery stub
that directs your agent to the always-current `npx -y coolify-axi` dashboard and help
output instead of duplicating command guidance.

You still need the [`coolify`](https://github.com/coollabsio/coolify-cli) CLI installed and
configured with at least one context (Node 20+ required):

```sh
coolify context add     # points at your Coolify instance with an API token
coolify-axi context     # confirm which instance is active
```

`-g` installs the skill for all projects (`~/.claude/skills/`, for example); drop it to
install for the current project only.

## Other Ways to Install

The skill is the recommended path, but it is not the only one.

### Zero setup

coolify-axi is an AXI, so any capable agent can run the CLI directly with nothing
installed at all. Just tell your agent:

```
Execute `npx -y coolify-axi` to get Coolify tools.
```

### Session hook

Want ambient context — every resource and its health — fed into each agent session instead
of loading on demand? Install the CLI globally and opt into the hook:

```sh
npm install -g coolify-axi
coolify-axi setup hooks
```

This installs a `SessionStart` hook for **Claude Code**, **Codex**, and **OpenCode** that
surfaces the current instance state at the start of each session. **Restart your agent
session after running this** so the new hook takes effect. `coolify-axi setup status`
reports what is installed, and `coolify-axi setup uninstall` removes it. You need the hook
or the skill, not both.

## Usage

```bash
coolify-axi                             # dashboard — every resource and its health
coolify-axi app list                    # applications only
coolify-axi app list --status exited    # only what is broken
coolify-axi app get digivaley           # domain, repo, branch, build pack
coolify-axi app logs digivaley          # recent container logs, truncated
coolify-axi app logs digivaley --lines 500 --full
coolify-axi app env digivaley           # env vars, values redacted
coolify-axi app env digivaley --reveal  # env vars in clear text
coolify-axi app restart digivaley
coolify-axi app stop karja-nl

coolify-axi deploy digivaley            # shorthand for `deploy run digivaley`
coolify-axi deploy digivaley --force    # rebuild without the layer cache
coolify-axi deploy list                 # in-flight and recent deployments

coolify-axi db list
coolify-axi db get blogs-pg             # connection details, secrets redacted
coolify-axi db get blogs-pg --reveal

coolify-axi service list
coolify-axi server list
coolify-axi context                     # configured instances, and which is active
coolify-axi update --check              # is a newer release available?
```

### Commands

| Command | Subcommands | Purpose |
| --- | --- | --- |
| *(none)* | — | Dashboard: every resource, its type, and its state |
| `app` | `list`, `get`, `logs`, `env`, `start`, `stop`, `restart` | Applications |
| `db` | `list`, `get` | Databases, with redacted connection details |
| `service` | `list`, `get` | One-click services |
| `server` | `list`, `get` | Connected servers |
| `deploy` | `run`, `list` | Trigger and watch deployments |
| `context` | — | Which Coolify instance commands target |
| `setup` | `hooks`, `status`, `uninstall` | Agent session integration |

Every subcommand takes `--help` for a concise reference with its flags and examples.

### Global flags

| Flag | Effect |
| --- | --- |
| `--context <name>` | Target a named Coolify instance instead of the configured default |
| `--help` | Print the command reference; always allowed, never reported as unknown |

Like the AXI SDK's other tools, flags must come **after** the command
(`coolify-axi app list --status exited`, not `coolify-axi --status exited app list`).

`COOLIFY_AXI_BIN` overrides the path to the wrapped `coolify` binary when it is not on PATH.

## Behaviour worth relying on

- **Names, not uuids.** Every command accepts a resource name or a uuid. An ambiguous name
  stops and lists the candidates rather than acting on the wrong resource.
- **Secrets are redacted by default.** `app env` and `db get` mask secret-shaped values, and
  scrub passwords embedded in connection URLs such as `postgres://user:pw@host/db`. `--reveal`
  opts in, and threads `--show-sensitive` through to the wrapped CLI.
- **Idempotent state changes.** `app start` and `app stop` exit 0 as a no-op when the app is
  already in the target state, so agents declare intent instead of reading first.
- **Truncation with an escape hatch.** Logs are capped with a size hint and a `--full` pointer,
  so one noisy container cannot consume the context budget.
- **Fails loud.** An unknown flag exits 2 and names that subcommand's valid flags inline, so
  the agent corrects in one turn instead of making a `--help` call.
- **Clean channels.** Structured TOON on stdout, including errors. The wrapped CLI's
  "A new version is available" banner is filtered out rather than corrupting parsed output.

## Development

```sh
npm install
npm test              # node:test, no framework, no network
npm run build:skill   # regenerate skills/coolify-axi/SKILL.md from src/skill.js
npm run check:skill   # CI drift check
node bin/coolify-axi.js --help
```

Tests run against `tests/fixtures/fake-coolify.mjs`, a stand-in binary wired up through
`COOLIFY_AXI_BIN`. That exercises the real spawn path — argv construction, JSON parsing, and
stderr-banner filtering — rather than mocking the wrapper away.

See [AGENTS.md](AGENTS.md) for architecture and sharp-edge notes, and
[CONTRIBUTING.md](CONTRIBUTING.md) for the release process.

## License

MIT
