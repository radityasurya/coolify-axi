# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build,
test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## What this is

`coolify-axi` wraps the official [`coolify`](https://github.com/coollabsio/coolify-cli) Go
CLI, the way `gh-axi` wraps `gh`. It shells out with `--format json`, projects the result
down to an agent-sized schema, and renders TOON through `axi-sdk-js`. There is no direct
Coolify REST client here on purpose: the wrapped CLI already owns contexts, tokens, and
instance selection, and reimplementing that would fork the auth story.

## Toolchain differs from gh-axi deliberately

gh-axi is TypeScript + pnpm + vitest + eslint. This package is plain ESM JavaScript + npm +
`node:test`, with no build step and no transpile. The AXI contract is about the *interface*
the agent sees, not the authoring language, and a zero-build package keeps `npx -y
coolify-axi` fast because there is no `dist/` to publish or keep in sync. If this grows to
gh-axi's size, revisit — but do not convert for symmetry alone.

## The wrapped CLI writes an update banner to stderr (`src/coolify.js`)

`coolify` prints `A new version (x.y.z) is available. Update with: coolify update` on
**stderr** for essentially every invocation. It does not corrupt stdout JSON, but it is
noise that must never reach the agent, and it must not be mistaken for a diagnostic when a
command genuinely fails. `meaningfulStderr()` filters that one line before error
translation; `tests/fixtures/fake-coolify.mjs` always emits it so the filtering is covered.

## `--reveal` must reach the wrapped CLI (`src/commands/app.js`, `src/commands/db.js`)

`coolify` masks secret values as `********` unless it is given `-s`/`--show-sensitive`. An
early version of `--reveal` only skipped *our* redaction, so it faithfully printed the
wrapped CLI's asterisks. Any new command that surfaces a secret must append
`--show-sensitive` to the child argv when `--reveal` is set, not just bypass `redact()`.

## Redaction decides from the name a value is filed under (`src/coolify.js`)

`redact(record)` matches the record's **field names**. An `app env` row is
`{ key, value }` — so passing the whole row through `redact()` matched the field literally
named `key` and redacted the variable's *name*, leaving its secret *value* in the clear.
Exactly backwards, and caught only by an assertion on which half was masked.

Use `redactValue(name, value, reveal)` whenever the deciding name is data (an env var's
key) rather than a schema field. `redact()` is for records whose field names *are* the
schema, like a database detail payload.

## Key-name matching alone leaks connection strings (`src/coolify.js`)

Coolify returns `internal_db_url` / `external_db_url` as
`postgres://user:PASSWORD@host/db`. The key name looks innocent, so name matching passes it
straight through. `URL_CREDENTIALS` scrubs the password segment out of any string value that
parses as a credentialed URL. Any new secret-bearing field should be assumed to be of this
shape until proven otherwise.

## Databases are not addressable through `resource list` (`src/commands/db.js`)

`coolify resource list` reports databases with `type: "standalone-postgresql"`, not
`postgresql`, and the per-engine variants multiply. `db` commands therefore resolve names
against `coolify database list` directly instead of going through `resolveResource()`.
`resolveResource()` is for applications and services, where the `type` value is stable.

## Name resolution is the core value-add (`src/coolify.js#resolveResource`)

Every wrapped subcommand takes a uuid and nothing else. Agents know names. `resolveResource`
matches uuid first, then exact name, and refuses to guess on a tie — listing the uuids
instead. On a miss it offers substring near-matches, which turns a typo into one corrective
turn. Preserve the refuse-to-guess behaviour: silently picking the first match is how an
agent restarts the wrong production app.

## `app list` is ~31 KB of JSON for three apps

Applications carry base64-encoded Traefik `custom_labels`, the raw compose file, and every
build-pack path. `MAX_BUFFER` in `src/coolify.js` is sized at 64 MB for that reason, and
`DETAIL_FIELDS` in `src/commands/app.js` is an allow-list, not a deny-list — a new Coolify
field is excluded by default, which is the correct direction for a token budget.

## `deploy <name>` shorthand (`src/commands/deploy.js`)

The dispatcher special-cases a first positional that is neither a flag nor a known
subcommand and routes it to `run`. Deploying is the overwhelmingly common action, and
`deploy run x` reads as a stutter. If a new `deploy` subcommand is added, it must be listed
in that guard or it will be swallowed as a resource name.

## Installable skill (`src/skill.js` → `skills/coolify-axi/SKILL.md`)

The shipped skill stays a minimal stub and defers to the CLI for actual guidance. CLI output
(`coolify-axi` dashboard, `--help`, `<command> --help`) is the single source of truth. Never
re-duplicate CLI-owned instructions into the skill; prefer a pointer over restated detail.
Regenerate with `npm run build:skill`; CI runs `npm run check:skill` and
`guard-generated-files.yml` blocks hand-edits under `skills/`.

## Release process

Releases are cut by release-please from conventional commits on `main`; merging the bot's
release PR triggers `npm publish` via `.github/workflows/release-please.yml`. Do not
hand-edit `CHANGELOG.md` or `.release-please-manifest.json` — a guard workflow blocks PRs
that touch them.

Publishing uses **npm trusted publishing (OIDC)**, not a stored token. The workflow's
`id-token: write` permission lets npm verify the workflow's identity directly, so there is
no `NPM_TOKEN` secret to rotate or leak, and provenance is attested automatically. This is
not merely tidier: the npm account is passkey-protected with `two-factor auth:
auth-and-writes`, so any token capable of unattended publishing would be a deliberate hole
in that 2FA — which is exactly what npm is now restricting.

The trust relationship is registered once, against the **workflow filename**:

```sh
npm trust github coolify-axi --repo radityasurya/coolify-axi --file release-please.yml --allow-publish
```

Renaming `release-please.yml` therefore breaks publishing until the relationship is
re-registered. `npm trust list coolify-axi` shows the current configuration.

Every `pull_request` workflow uses `paths-ignore` for the release-please output set
(`.release-please-manifest.json`, `CHANGELOG.md`, `package.json`) so release PRs create zero
runs.

## Testing without a Coolify instance

`tests/fixtures/fake-coolify.mjs` is a stand-in binary selected via `COOLIFY_AXI_BIN`. It
keys on the leading subcommand path only, stopping at the first flag — otherwise a flag
*value* (`--lines 100`) lands in the lookup key and every log test misses. Tests therefore
exercise the real `execFile` path rather than mocking the wrapper, which is what caught both
redaction bugs above.

## Test discovery: `tests/`, not `test/` (CI caught this)

Two traps stacked here, both surfaced only on Node 20 in CI:

- `node --test "test/*.test.js"` needs the runner to expand the glob itself, which is
  **Node 22+**. On Node 20 the pattern is taken literally and the run fails with
  `Could not find '.../test/*.test.js'`. The script is therefore a bare `node --test`,
  relying on default discovery.
- Default discovery treats **every file under a directory named `test`** as a test file, not
  just `*.test.js`. That ran `fake-coolify.mjs` (which exits 1 by design when handed an
  unknown command) as a test, and reported `helpers.js` as an empty passing test.

Naming the directory `tests` fixes both: `tests/*.test.js` still matches the default
`**/*.test.js` pattern by name, while `tests/helpers.js` and `tests/fixtures/**` match none
of the default patterns and stay out of the run. Do not rename it back to `test/`.
