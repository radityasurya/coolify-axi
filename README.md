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
coolify-axi app get digivaley           # domain, repo, branch, build pack, base directory, health check
coolify-axi app logs digivaley          # recent container logs, truncated
coolify-axi app logs digivaley --lines 500 --full
coolify-axi app logs digivaley --lines 1000 --grep "error|refused"  # repeats fold into [xN]; --keep-repeats to disable
coolify-axi app env digivaley           # env vars, values redacted
coolify-axi app env digivaley --reveal  # env vars in clear text
coolify-axi app env set digivaley KEY=VALUE            # runtime-only; add --build for build time
coolify-axi app env delete digivaley OLD_KEY
coolify-axi app set digivaley --build-pack dockerfile --dockerfile-location /Dockerfile
coolify-axi app set digivaley --build-secrets on --inject-build-args off   # build-time env vars as BuildKit secrets
coolify-axi app set digivaley --pre-deploy "pnpm db:migrate" --health-check on --auto-deploy on
printf %s "$SECRET" | coolify-axi app set digivaley --webhook-secret-github-stdin
coolify-axi app create web --repo acme/web --branch main --server localhost --project blog --github-app acme-gh
coolify-axi app create web --repo git@github.com:acme/web.git --branch main --server localhost --project blog --deploy-key coolify-hireopz --destination <uuid>   # --destination also on db create
coolify-axi app domain digivaley --clear      # remove every domain on purpose (an app created without --domain gets a public sslip.io one)
coolify-axi app labels digivaley        # container labels; basicauth.users values redacted
coolify-axi app labels digivaley --add "traefik.enable=true" --remove old.label   # or --set-file labels.txt; deploy to apply
coolify-axi app domain modreview-wp --service wordpress https://modreview.net   # Docker Compose app: domains per compose service
coolify-axi app restart digivaley
coolify-axi app stop karja-nl

coolify-axi deploy digivaley            # shorthand for `deploy run digivaley`; prints the deployment uuid
coolify-axi deploy digivaley --wait     # follow it, then print a summary
coolify-axi deploy digivaley --force    # rebuild without the layer cache
coolify-axi deploy list                 # in-flight and recent deployments
coolify-axi deploy history digivaley    # past deployments, newest first
coolify-axi deploy logs digivaley       # why the latest one failed; --full for the log, --debug for hidden entries
coolify-axi deploy watch digivaley      # poll until it ends (--timeout 300 s by default)

coolify-axi db list
coolify-axi db get blogs-pg             # connection details, secrets redacted
coolify-axi db get blogs-pg --reveal
coolify-axi db create postgres blogs-pg --server localhost --project blog   # password never printed
coolify-axi db create mariadb wp-db --server localhost --project blog   # also mysql, redis

coolify-axi service list
coolify-axi service get cAdvisor            # project, environment, server and destination uuids, env keys
coolify-axi service compose cAdvisor        # Docker Compose source, secrets redacted
coolify-axi service env cAdvisor            # values redacted except {{team.X}} references
coolify-axi service env cAdvisor --set 'ACCESS_TOKEN={{team.GH_RUNNER_TOKEN}}'
coolify-axi service domain modreview-wp --service wordpress https://modreview.net   # domains of one sub-service
coolify-axi service set cAdvisor --predefined-network on   # Connect To Predefined Network; restart to apply
coolify-axi service restart cAdvisor
coolify-axi service create --list-types     # every valid one-click type
coolify-axi service create n8n --project-uuid <uuid> --server-uuid <uuid>
coolify-axi service create --docker-compose-file compose.yml --name runner-2 \
  --project-uuid <uuid> --environment-uuid <uuid> --server-uuid <uuid> --destination-uuid <uuid>
coolify-axi service delete cAdvisor --yes   # refuses without --yes
coolify-axi project list
coolify-axi project get blog                # environments with id, name, uuid
coolify-axi shared-env                      # team shared variable keys, never values
coolify-axi shared-env --project blog --environment production
coolify-axi server list
coolify-axi context                     # configured instances, and which is active
coolify-axi update --check              # is a newer release available?
```

### Clone a service

```bash
coolify-axi service get runner                 # 1. project, environment, server, destination uuids
coolify-axi service compose runner             # 2. compose source, secrets redacted; save it to runner.yml
coolify-axi service create --docker-compose-file runner.yml --name runner-2 \
  --project-uuid <uuid> --environment-uuid <uuid> --server-uuid <uuid> --destination-uuid <uuid>
coolify-axi shared-env                         # 3. which shared variable to point at
coolify-axi service env runner-2 --set 'ACCESS_TOKEN={{team.GH_RUNNER_TOKEN}}'
coolify-axi service start runner-2             # 4. deploy it
```

### Commands

| Command | Subcommands | Purpose |
| --- | --- | --- |
| *(none)* | — | Dashboard: every resource, its type, and its state |
| `app` | `list`, `get`, `logs`, `env`, `set`, `create`, `start`, `stop`, `restart` | Applications; `env set`/`env delete` change variables, `set` changes deploy settings |
| `db` | `list`, `get`, `create` | Databases, with redacted connection details; `create` takes `postgres` or `redis` |
| `service` | `list`, `get`, `compose`, `create`, `delete`, `start`, `stop`, `restart`, `domain`, `env` | Services from a template type or your own compose; delete is `--yes`-gated |
| `project` | `list`, `get` | Projects and their environments (id, name, uuid) |
| `shared-env` | `list` | Shared variable keys at team, project (`--project`), or environment (`--environment`) scope |
| `server` | `list`, `get` | Connected servers |
| `deploy` | `run`, `list`, `history`, `logs`, `watch` | Trigger, follow, and diagnose deployments |
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
- **Secrets are redacted by default.** `app env` and `service env` mask every value except a
  value that is exactly a shared-variable reference (`{{team.X}}`, `{{project.X}}`,
  `{{environment.X}}`), which names a value instead of holding one. `db get` masks
  secret-shaped values and scrubs passwords embedded in connection URLs such as
  `postgres://user:pw@host/db`. `--reveal` opts in, and threads `--show-sensitive` through to
  the wrapped CLI.
- **Compose is redacted, references stay.** `service compose` masks the value of every key that
  contains `TOKEN`, `SECRET`, `KEY`, `PASS`, `PAT` (as a word, so `PATH` stays readable), or
  `CREDENTIAL`, in map (`KEY: value`) and list (`- KEY=value`) form. It also masks GitHub
  tokens, credentialed URLs, and private keys under any key. `${VAR}` interpolations and
  shared-variable references stay visible. There is no `--reveal`.
- **Shared variables print keys only.** `shared-env` lists each key with the reference to store
  in a resource's variable, such as `{{team.GH_RUNNER_TOKEN}}`. It never prints a value.
- **Logs are always redacted.** `app logs` and `deploy logs` mask secrets by shape (build-arg
  values, secret-named `KEY=VALUE`, credentialed URLs, bearer headers, private keys) and have no
  `--reveal`. Errors from the wrapped CLI are redacted too. `env set` never echoes values, and the
  GitHub webhook secret in `app set` is write-only: output says `set` or `cleared`.
- **REST where the CLI falls short.** `app set` changes settings the `coolify` CLI has no flags
  for (deploy hooks, health check, watch paths, auto-deploy, webhook secret). `service get`,
  `service compose`, and `project get` read fields the CLI drops (environment ids, the
  destination, the compose source). `service create` posts to the API because the CLI cannot
  create from a compose file. Each reads the instance and token from the CLI's own config and
  never prints the token. `service get` shows the server and destination uuids, and
  `service compose` shows the compose, only when the token has the `read:sensitive` ability.
- **Idempotent state changes.** `app start`/`stop` and `service start`/`stop` exit 0 as a
  no-op when the resource is already in the target state, so agents declare intent instead of
  reading first. When Coolify ignores a lifecycle request (an old CLI that sends `GET`), the
  command fails instead of reporting success.
- **Destructive commands ask first.** `service delete` refuses to run without `--yes`. Without
  it, the command names the resource, its uuid, and what deletion removes, then exits 2 with
  no call reaching the wrapped CLI. `--yes` passes `--force` through so it never prompts
  interactively either.
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
