# Vision

## The problem

Coolify's own CLI is built for humans at a terminal. It prints tables, addresses everything
by uuid, and returns the API's full object graph when asked for JSON — about 31 KB for three
applications, most of it base64 Traefik labels and build-pack paths.

An agent driving a deploy does not need any of that. It needs to know what is running, what
broke, and what to do next, in as few tokens and as few turns as possible.

## What coolify-axi is

A thin, agent-ergonomic surface over the same CLI, following the ten
[AXI](https://axi.md) principles. It owns three things the wrapped CLI does not:

1. **Projection.** An allow-list of the fields that inform a decision, in TOON.
2. **Addressing.** Names resolve to uuids, and ambiguity stops rather than guesses.
3. **Safety.** Secrets are redacted by default, including passwords embedded in connection
   URLs, so a transcript is not a credential leak.

## What it deliberately does not do

- **No resource creation or deletion.** `create`, `delete`, and destructive `update` stay in
  the wrapped CLI and the dashboard. An agent that can delete a production database on a
  misparsed name is a liability, and the token savings are nil.
- **No interactive anything.** Every operation completes from flags alone. Commands that
  would prompt fail loudly instead.
- **No direct REST client.** Contexts, tokens, and instance selection belong to the wrapped
  CLI. Forking that would mean two auth stories that drift.
- **No log streaming.** `--follow` is a human affordance; an agent wants a bounded, truncated
  tail it can reason about.

## Where it could go

- `app env set` with the same stdin-only handling gh-axi uses for secrets, so values never
  appear in argv.
- Deployment watching — poll until a deployment reaches a terminal state, returning the
  outcome and failed log lines in one call rather than N polling turns.
- Backup inspection for databases, which is read-only and maps cleanly onto the existing
  redaction rules.
