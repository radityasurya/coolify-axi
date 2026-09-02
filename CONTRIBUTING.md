# Contributing

## Getting set up

```sh
npm install
npm test
```

Node 20+ is required; CI runs the suite on 20, 22, and 24. There is no build step and no
transpile — `bin/coolify-axi.js` runs `src/` directly.

The test suite needs no Coolify instance and makes no network calls. It runs against
`tests/fixtures/fake-coolify.mjs`, a stand-in for the wrapped binary selected through
`COOLIFY_AXI_BIN`.

## Before you push

```sh
npm test
npm run check:skill
```

## Conventions

- **Conventional commits.** `feat:`, `fix:`, and `docs:` drive release-please. Anything else
  will not appear in the changelog.
- **Generated files are generated.** `skills/coolify-axi/SKILL.md` comes from `src/skill.js`
  via `npm run build:skill`. `CHANGELOG.md` and `.release-please-manifest.json` belong to
  release-please. A guard workflow fails PRs that hand-edit any of them.
- **Allow-list new fields.** Output schemas are allow-lists (`DETAIL_FIELDS` and friends). A
  new upstream field should stay out of default output unless it informs a decision.
- **Every mutation is idempotent or says why not.** If a command cannot be safely re-run,
  that belongs in a comment and in the command's `--help`.
- **Secrets never widen.** New fields that could carry a credential go through `redact()` or
  `redactValue()`, and `--reveal` must thread `--show-sensitive` to the wrapped CLI.
- **Read [AGENTS.md](AGENTS.md) first.** It documents the traps that have already bitten,
  including two inverted-redaction bugs.

## Releasing

Merging the release-please PR on `main` tags the release and publishes to npm. Publishing
requires an `NPM_TOKEN` repository secret. Verify afterwards with
`npm view coolify-axi version`.
