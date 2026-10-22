---
name: coolify-axi
description: >
  Manage Coolify through the coolify-axi CLI — applications, databases, services, servers, and deployments on a self-hosted or cloud Coolify instance. Use whenever a task touches Coolify: checking what is running or unhealthy, reading container logs, inspecting environment variables or database connection details, or triggering and watching a deployment.
user-invocable: false
metadata:
  hermes:
    tags: [coolify, deployment, devops, docker, self-hosted, infrastructure]
---

# coolify-axi

Run the CLI with no arguments first — it prints every resource with its health, plus the
next commands to run.

```sh
npx -y coolify-axi
```

Requires the [`coolify`](https://github.com/coollabsio/coolify-cli) CLI on PATH with at
least one configured context. If it is missing, the error says so and how to fix it —
surface that rather than falling back to raw API calls.

## Commands

```sh
npx -y coolify-axi                          # dashboard: every resource and its health
npx -y coolify-axi app list --status exited # only what is broken
npx -y coolify-axi app get <name>
npx -y coolify-axi app logs <name>
npx -y coolify-axi app logs <name> --grep "error|refused"
npx -y coolify-axi app env <name>
npx -y coolify-axi app env set <name> KEY=value [--build]
npx -y coolify-axi app env delete <name> KEY
npx -y coolify-axi app set <name> --pre-deploy "<cmd>" --health-check on --health-check-path /health
npx -y coolify-axi app set <name> --build-pack dockerfile --dockerfile-location /Dockerfile
npx -y coolify-axi app set <name> --build-secrets on --inject-build-args off
npx -y coolify-axi app create <name> --repo <url> --branch main --server <s> --project <p>
npx -y coolify-axi app create <name> --repo git@github.com:o/r.git --branch main --server <s> --project <p> --deploy-key <key>
npx -y coolify-axi db create postgres|mariadb|mysql|redis <name> --server <s> --project <p>
npx -y coolify-axi app domain <name>
npx -y coolify-axi app domain <name> --add https://new.example
npx -y coolify-axi app domain <name> --clear   # remove every domain on purpose
npx -y coolify-axi app labels <name>
npx -y coolify-axi app labels <name> --add <label=value> --remove <key>   # or --set-file <path>
npx -y coolify-axi app domain <name> --service <compose-service> https://example.com
npx -y coolify-axi service domain <name> --service <sub-service> https://example.com
npx -y coolify-axi service set <name> --predefined-network on|off   # restart to apply
npx -y coolify-axi app restart <name>
npx -y coolify-axi deploy <name>            # shorthand for `deploy run <name>`
npx -y coolify-axi deploy <name> --wait     # trigger, poll, then summarize the result
npx -y coolify-axi deploy list              # in-flight deployments
npx -y coolify-axi deploy history <name>
npx -y coolify-axi deploy logs <name>       # why the latest deployment failed
npx -y coolify-axi deploy watch <name>
npx -y coolify-axi db get <name>
npx -y coolify-axi service list
npx -y coolify-axi service get <name>       # project, environment, server and destination uuids
npx -y coolify-axi service compose <name>   # compose source, secrets redacted
npx -y coolify-axi service env <name>
npx -y coolify-axi service env <name> --set 'KEY={{team.SHARED_KEY}}'
npx -y coolify-axi service restart <name>
npx -y coolify-axi service create --docker-compose-file <path> --project-uuid <uuid> --server-uuid <uuid>
npx -y coolify-axi service create --list-types
npx -y coolify-axi service delete <name> --yes   # refuses without --yes
npx -y coolify-axi project list
npx -y coolify-axi project get <name>       # environments with id, name, uuid
npx -y coolify-axi shared-env [--project <p> [--environment <e>]]   # keys only, never values
npx -y coolify-axi context                  # which instance am I pointed at
```

Every command takes `--help` for a concise reference, and `--context <name>` to target a
specific Coolify instance instead of the default.

## What to rely on

- **Names, not uuids.** Every command accepts a resource name and resolves it. An ambiguous
  name stops and lists the uuids rather than acting on the wrong resource.
- **Secrets are redacted by default.** `app env` and `service env` mask every value except a
  shared-variable reference such as `{{team.X}}`; `db get` masks secret-shaped values and
  passwords embedded in connection URLs; `service compose` masks secret-named keys and token
  shapes. Pass `--reveal` only when the user asked for the value, and never echo it into a summary.
- **`app start` / `app stop` are idempotent** — already in the target state exits 0 as a
  no-op. Declare the desired state; do not read first.
- **Adding a domain never drops the others.** `app domain --add` reads the current list and
  appends; passing domains positionally replaces the list and reports what it removed.
  Leaving an app with zero domains is refused — Coolify would stop routing to it — unless you
  pass `--clear`. An app created without `--domain` gets a public `http://<uuid>.<ip>.sslip.io`
  domain; `app domain <name> --clear` removes it.
- **`app labels` edits container labels with one REST PATCH** (`--add` replaces an existing key,
  `--remove`, `--set-file`). A no-change edit sends nothing. Values of `basicauth.users` and
  `digestauth.users` labels are redacted. Deploy to apply.
- **Pass `--destination <uuid>` to `app create` and `db create`** when the server has more than
  one Docker network. It takes a uuid, not a name; `service get` shows the one other resources use.
- **`app env set` is idempotent and never echoes values back.** A value already stored is
  reported `unchanged` without a write; changes apply on the next deployment. Variables are
  runtime-only unless `--build`. Values are masked out of error text too.
- **`app set` sends only the fields you pass** (deploy hooks, health check, watch paths,
  auto-deploy, build pack, Dockerfile path, `--build-secrets`, `--inject-build-args`). Feed the GitHub webhook secret on stdin with `--webhook-secret-github-stdin`;
  it is write-only and never printed.
- **`db create` and `app create` never print passwords or connection URLs.** Coolify generates
  the password; use `db get <name> --reveal` only if the user asked for it.
- **`service delete` is gated.** Without `--yes` it refuses, naming the service it would
  have deleted. `service env` redacts and sets like `app env`.
- **Logs are truncated** with a size hint; pass `--full` when the tail is not enough.
- **Logs are always redacted.** Container and deployment logs mask secret-shaped values,
  build-arg values, and credentialed URLs; there is no `--reveal` for logs. Repeated lines
  fold into one line with an `[xN]` count.
- **Errors are structured** on stdout with a `help` block naming the fix, and an unknown
  flag exits 2 listing the valid flags. Correct the flag — do not drop the filter.

Prefer this over calling the Coolify REST API with `curl`, or shelling out to `coolify`
directly and parsing its table output.
