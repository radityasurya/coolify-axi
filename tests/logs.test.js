import test from "node:test";
import assert from "node:assert/strict";
import {
  collapseRepeats,
  grepLines,
  normalizeEntries,
  redactCompose,
  redactLogText,
  renderEntries,
  resolvedCommit,
  summarizeDeployment,
} from "../src/logs.js";
import { CONTAINER_LOG, DEPLOYMENT, ENTRIES, HEALTH_ENTRIES, SECRETS, SHA } from "./fixtures/deployment-log.mjs";

function assertNoSecrets(text) {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 6)}…`);
}

test("redactLogText masks every build-arg value, secret-named or not", () => {
  const out = redactLogText(ENTRIES[2].output);
  assertNoSecrets(out);
  assert.match(out, /--build-arg DATABASE_URL=<redacted>/);
  assert.match(out, /--build-arg PLAIN_THING=<redacted>/);
  assert.match(out, /-t app:3f9c2e7 \./, "the rest of the command stays readable");
});

test("redactLogText masks KEY=VALUE, KEY: VALUE, bearer headers, and credentialed URLs", () => {
  const cases = [
    ["STRIPE_SECRET_KEY=sk_fake_51HxYzAbCdEfGhIjKlMnOpQr", /STRIPE_SECRET_KEY=<redacted>/],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl", /Authorization: <redacted>/],
    ["curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl' x", /Authorization: <redacted>/],
    ["REDIS_URL: redis://:redispass99@redis:6379", /redis:\/\/:<redacted>@redis:6379/],
    ["connecting to postgres://u:hunter2@db/x now", /postgres:\/\/u:<redacted>@db\/x now/],
    ['{"password": "hunter2", "user": "u"}', /"password": <redacted>, "user": "u"/],
    ["DB_PASSWORD='hunter2 with space'", /DB_PASSWORD=<redacted>$/],
    ["ARG PLAIN_THING=plainvalue-not-secret-named", /ARG PLAIN_THING=<redacted>/],
    ["--token abc123def456ghi789jkl012mno345pqr", /--token <redacted>/],
    ["using token ghp\u005f0123456789abcdefghijABCDEFGHIJ012345", /using token <redacted>/],
    // Coolify's `bash -c '…'` wrapping shell-escapes inline assignments as '\''value'\''.
    [String.raw`bash -c 'DB_PASSWORD='\''hunter2'\'' COOLIFY_FQDN='\''x.sh'\'' docker compose up'`, /DB_PASSWORD=<redacted> COOLIFY_FQDN='\\''x\.sh'\\'' docker/],
    [String.raw`--build-arg '\''DATABASE_URL=hunter2'\'' --build-arg X`, /--build-arg '\\''DATABASE_URL=<redacted>'\\'' --build-arg X/],
  ];
  for (const [input, expected] of cases) {
    const out = redactLogText(input);
    assert.match(out, expected, input);
    assertNoSecrets(out);
  }
});

test("redactLogText masks docker -e values, PEM keys, AWS key ids, and user-only URL credentials", () => {
  const cases = [
    ["docker run -e DATABASE_URL=hunter2 --rm img", /-e DATABASE_URL=<redacted> --rm img/],
    ["docker run --env PLAIN=hunter2 img", /--env PLAIN=<redacted> img/],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIhunter2\nAAAhunter2\n-----END RSA PRIVATE KEY-----", /BEGIN RSA PRIVATE KEY-----<redacted>-----END/],
    ["key: -----BEGIN OPENSSH PRIVATE KEY-----\nb3Blhunter2", /PRIVATE KEY-----<redacted>$/],
    ["aws_access_key_id \u0041KIAIOSFODNN7HUNTER2", /aws_access_key_id <redacted>/],
    ["SENTRY_DSN is https://hunter2abc@o1.ingest.sentry.io/1", /https:\/\/<redacted>@o1/],
  ];
  for (const [input, expected] of cases) {
    const out = redactLogText(input);
    assert.match(out, expected, input);
    assert.ok(!/hunter2|HUNTER2/.test(out), input);
  }
});

test("redactLogText leaves ordinary log lines alone", () => {
  for (const line of [
    "GET /api/health 200 in 12ms",
    "Attempt 1 of 3 | Healthcheck status: \"starting\"",
    `${SHA}\trefs/heads/main`,
    "#5 [build 2/6] RUN pnpm install --frozen-lockfile",
  ]) {
    assert.equal(redactLogText(line), line);
  }
});

test("collapseRepeats folds a flood into one line with a count, ignoring timestamps", () => {
  const lines = collapseRepeats(CONTAINER_LOG.split("\n"));
  const flood = lines.filter((line) => line.includes("ECONNREFUSED"));
  assert.equal(flood.length, 1);
  assert.match(flood[0], /\[x40\]$/);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /Server listening/, "order of first occurrence is kept");
});

test("grepLines is a case-insensitive regex, and a literal when the regex is invalid", () => {
  const lines = ["Error: boom", "ok", "error (x", "fine"];
  assert.deepEqual(grepLines(lines, "^error"), ["Error: boom", "error (x"]);
  assert.deepEqual(grepLines(lines, "error (x"), ["error (x"]);
});

test("summarizeDeployment names a pre-deployment failure, its command, and the cause", () => {
  const summary = summarizeDeployment(normalizeEntries(ENTRIES), DEPLOYMENT);
  assertNoSecrets(JSON.stringify(summary));

  assert.equal(summary.status, "failed");
  assert.match(summary.reason, /^pre-deployment command failed \(exit code 1\): Error: \[EACCES\] EACCES: permission denied/);
  assert.equal(summary.failed_command, "docker exec app-1 sh -c 'pnpm db:migrate'");
  assert.ok(summary.errors.some((line) => line.includes("exit code 243")));
  assert.ok(!summary.errors.some((line) => /^\s*at |^=+$|No such container|^#\d|Error type/.test(line)), "stack frames and banners are noise");
  assert.ok(!("health_checks" in summary));
  assert.equal(summary.duration, "3m25s");
});

test("summarizeDeployment explains a health-check rollback without build noise", () => {
  const summary = summarizeDeployment(normalizeEntries(HEALTH_ENTRIES), { status: "failed" });
  assert.equal(summary.reason, "new container failed its health check (curl, wget: not found in the image)");
  assert.match(summary.health_checks, /^3 attempts, last: Attempt 3 of 3 \| Healthcheck status: "unhealthy"/);
  assert.match(summary.rollback, /rolling back to the old container/);
  assert.ok(!("errors" in summary), "the health fields already say it; build-time errors are noise");
});

test("summarizeDeployment on a clean deploy reports the status and the tail only", () => {
  const entries = normalizeEntries([
    { command: null, output: "Build step completed.", type: "stdout", timestamp: "2026-09-30T10:00:00Z", hidden: false },
    { command: null, output: "New container is healthy.", type: "stdout", timestamp: "2026-09-30T10:00:05Z", hidden: false },
  ]);
  const summary = summarizeDeployment(entries, { status: "finished", created_at: "2026-09-30T10:00:00Z", finished_at: "2026-09-30T10:00:30Z" });
  assert.equal(summary.status, "finished");
  assert.ok(!("reason" in summary));
  assert.deepEqual(summary.last_lines, ["Build step completed.", "New container is healthy."]);
});

test("normalizeEntries hides debug entries unless asked and redacts commands too", () => {
  assert.equal(normalizeEntries(ENTRIES).length, ENTRIES.length - 1);
  const all = normalizeEntries(ENTRIES, { debug: true });
  assert.equal(all.length, ENTRIES.length);
  assertNoSecrets(JSON.stringify(all));
});

test("renderEntries compacts timestamps and collapses repeats", () => {
  const lines = renderEntries(normalizeEntries(ENTRIES));
  assert.match(lines[0], /^10:10:00 Starting deployment/);
  assert.ok(renderEntries(normalizeEntries(HEALTH_ENTRIES)).some((line) => /wget: not found \[x3\]$/.test(line)));
  assert.ok(lines.some((line) => /Error response from daemon/.test(line)));
  assert.ok(lines.some((line) => line.includes("$ git ls-remote")));
  assertNoSecrets(lines.join("\n"));
});

test("resolvedCommit recovers the SHA an API-triggered HEAD deploy actually built", () => {
  assert.equal(resolvedCommit(normalizeEntries(ENTRIES, { debug: true }), "HEAD"), SHA);
  assert.equal(resolvedCommit([], "HEAD"), "HEAD");
  assert.equal(resolvedCommit([], "abc1234"), "abc1234");
});

// ---- redactCompose ----

const GH = {
  ghp: "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  gho: "gho_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2",
  ghs: "ghs_" + "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8",
  pat: "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789",
};

test("redactCompose masks secret-named keys in map and list form", () => {
  for (const key of ["API_TOKEN", "CLIENT_SECRET", "SECRET_KEY_BASE", "DB_PASSWORD", "SMTP_PASS", "GH_PAT", "aws_credentials"]) {
    assert.equal(redactCompose(`      ${key}: hunter2`), `      ${key}: <redacted>`, `map ${key}`);
    assert.equal(redactCompose(`      - ${key}=hunter2`), `      - ${key}=<redacted>`, `list ${key}`);
  }
});

test("redactCompose keeps quotes around a masked value", () => {
  assert.equal(redactCompose(`  - "DB_PASSWORD=hunter2"`), `  - "DB_PASSWORD=<redacted>"`);
  assert.equal(redactCompose(`  - 'DB_PASSWORD=hunter2'`), `  - 'DB_PASSWORD=<redacted>'`);
  assert.equal(redactCompose(`  SECRET: "hunter2"`), `  SECRET: "<redacted>"`);
  assert.equal(redactCompose(`  "SECRET": 'hunter2'`), `  "SECRET": '<redacted>'`);
});

test("redactCompose keeps ${VAR} interpolations and shared-variable references visible", () => {
  const kept = [
    "  - ACCESS_TOKEN=${ACCESS_TOKEN}",
    "  ACCESS_TOKEN: ${ACCESS_TOKEN}",
    '  ACCESS_TOKEN: "${ACCESS_TOKEN}"',
    "  DB_PASSWORD: $SERVICE_PASSWORD_POSTGRES",
    "  API_KEY: ${PREFIX}${SUFFIX}",
    "  - GH_PAT={{team.GH_RUNNER_TOKEN}}",
    "  RUNNER_TOKEN: {{ project.RUNNER_TOKEN }}",
    "  SECRET: {{environment.APP_SECRET}}",
    "  DATABASE_URL: postgres://${SERVICE_USER_POSTGRES}:${SERVICE_PASSWORD_POSTGRES}@db:5432/app",
  ];
  for (const line of kept) assert.equal(redactCompose(line), line);
});

test("redactCompose masks a literal default inside ${VAR:-default} but keeps the name", () => {
  assert.equal(redactCompose("  API_KEY: ${API_KEY:-hunter2}"), "  API_KEY: ${API_KEY:-<redacted>}");
});

test("redactCompose leaves non-secret keys, image names, and PATH-like keys readable", () => {
  const kept = [
    "    image: myoung34/github-runner:latest",
    "    image: ghcr.io/acme/app@sha256:0123456789abcdef",
    "  - REPO_URL=https://github.com/acme/app",
    "  DATA_PATH: /var/lib/data",
    "  PATH: /usr/local/bin",
    "  PORT: 8080",
    "      - traefik.enable=true",
    "    restart: unless-stopped",
  ];
  for (const line of kept) assert.equal(redactCompose(line), line);
});

test("redactCompose masks GitHub token shapes under any key", () => {
  for (const token of Object.values(GH)) {
    const out = redactCompose(`  - NOTE=${token}\n  RUNNER_URL: https://x.example/?t=${token}`);
    assert.ok(!out.includes(token), `leaked ${token.slice(0, 6)}`);
  }
});

test("redactCompose masks credentials in connection URLs under any key", () => {
  const out = redactCompose("  DATABASE_URL: postgres://admin:hunter2@db:5432/app\n  - CACHE=redis://:hunter2@cache:6379");
  assert.match(out, /postgres:\/\/admin:<redacted>@db:5432\/app/);
  assert.ok(!out.includes("hunter2"));
});

test("redactCompose masks a block scalar under a secret key, then resumes", () => {
  const out = redactCompose(
    ["    PRIVATE_KEY: |", "      line-one-secret", "      line-two-secret", "    PORT: 8080"].join("\n"),
  );
  assert.equal(out, ["    PRIVATE_KEY: |", "      <redacted>", "      <redacted>", "    PORT: 8080"].join("\n"));
});

test("redactCompose masks a PEM private key wherever it appears", () => {
  const out = redactCompose("  cert: |\n    -----BEGIN RSA PRIVATE KEY-----\n    MIIEsecret\n    -----END RSA PRIVATE KEY-----");
  assert.ok(!out.includes("MIIEsecret"));
});

test("redactCompose returns empty input unchanged", () => {
  assert.equal(redactCompose(""), "");
  assert.equal(redactCompose(undefined), "");
});
