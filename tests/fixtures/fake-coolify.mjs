#!/usr/bin/env node
// Stands in for the real `coolify` binary. Responds to argv with canned JSON and
// always emits the update banner on stderr, so the wrapper's stderr filtering
// and JSON parsing are exercised for real rather than mocked away.
import { CONTAINER_LOG, DEPLOYMENT, SHA } from "./deployment-log.mjs";

process.stderr.write("A new version (9.9.9) is available. Update with: coolify update\n");

// Key on the leading subcommand path only — stop at the first flag so flag
// VALUES (e.g. `--lines 100`) do not leak into the lookup key.
const argv = process.argv.slice(2);
const firstFlag = argv.findIndex((a) => a.startsWith("--"));
const key = (firstFlag === -1 ? argv : argv.slice(0, firstFlag)).join(" ");

const RESOURCES = [
  { uuid: "app1".padEnd(24, "x"), name: "digivaley", type: "application", status: "running:healthy" },
  { uuid: "app2".padEnd(24, "x"), name: "karja-nl", type: "application", status: "exited:unhealthy" },
  { uuid: "svc1".padEnd(24, "x"), name: "cAdvisor", type: "service", status: "running:healthy" },
  { uuid: "dup".padEnd(24, "x"), name: "twin", type: "application", status: "running:healthy" },
  { uuid: "dup2".padEnd(24, "x"), name: "twin", type: "application", status: "running:healthy" },
];

const DATABASES = [
  {
    uuid: "db1".padEnd(24, "x"),
    name: "blogs-pg",
    type: "postgresql",
    status: "running:healthy",
    image: "postgres:18",
    postgres_user: "postgres",
    postgres_password: "hunter2",
    internal_db_url: "postgres://postgres:hunter2@blogs-pg/postgres",
  },
];

const SERVICES = [
  { uuid: "svc1".padEnd(24, "x"), name: "cAdvisor", status: "running:healthy", description: "" },
  { uuid: "svc2".padEnd(24, "x"), name: "umami", status: "exited:unhealthy", description: "analytics" },
];
const SERVERS = [
  { uuid: "srv1".padEnd(24, "x"), name: "localhost", ip: "host.docker.internal", user: "root", port: 22 },
];

const TABLE = {
  "resource list": RESOURCES,
  "service list": SERVICES,
  "server list": SERVERS,
  [`service get ${SERVICES[0].uuid}`]: { ...SERVICES[0], docker_compose: "services:\n  cadvisor:\n    image: gcr.io/cadvisor/cadvisor" },
  [`service get ${SERVICES[1].uuid}`]: SERVICES[1],
  [`server get ${SERVERS[0].uuid}`]: SERVERS[0],
  [`service start ${SERVICES[1].uuid}`]: { message: "starting" },
  [`service stop ${SERVICES[0].uuid}`]: { message: "stopping" },
  [`service restart ${SERVICES[0].uuid}`]: { message: "restarting" },
  [`service env list ${SERVICES[0].uuid}`]: [
    { key: "PORT", value: "8080", is_build_time: false },
    { key: "SERVICE_API_TOKEN", value: "hunter2", is_build_time: false },
    { key: "DATABASE_URL", value: "postgres://svc:hunter2@db/svc", is_build_time: false },
  ],
  "database list": DATABASES,
  [`database get ${DATABASES[0].uuid}`]: DATABASES[0],
  [`app get ${RESOURCES[0].uuid}`]: {
    name: "digivaley",
    uuid: RESOURCES[0].uuid,
    status: "running:healthy",
    fqdn: "https://digivaley.com",
    git_repository: "git@github.com:radityasurya/digivaley.com.git",
    git_branch: "master",
    build_pack: "dockerfile",
    custom_labels: "BASE64NOISE".repeat(400),
  },
  [`app env list ${RESOURCES[0].uuid}`]: [
    { uuid: "envnode", key: "NODE_ENV", value: "production", is_build_time: false },
    { uuid: "envpass", key: "DATABASE_PASSWORD", value: "hunter2", is_build_time: false },
  ],
  "project list": [{ uuid: "prj1".padEnd(24, "x"), name: "blog", description: "" }],
  "github list": [{ uuid: "gh1".padEnd(24, "x"), name: "acme-gh" }],
  "app create public": { uuid: "newapp".padEnd(24, "x"), domains: "https://web.example" },
  "app create github": { uuid: "newapp".padEnd(24, "x"), domains: "" },
  // Realistic secret-bearing response: none of these may reach the agent.
  "database create postgresql": {
    uuid: "newdb".padEnd(24, "x"),
    name: "blogs-pg",
    status: "created",
    postgres_user: "postgres",
    postgres_password: "S3cr3tPw",
    internal_db_url: "postgres://postgres:S3cr3tPw@newdb:5432/postgres",
    external_db_url: "postgres://postgres:S3cr3tPw@1.2.3.4:5433/postgres",
  },
  "database create redis": { uuid: "newrds".padEnd(24, "x"), name: "cache", redis_password: "R3disPw", internal_db_url: "redis://default:R3disPw@newrds:6379/0" },
  [`app stop ${RESOURCES[0].uuid}`]: { message: "stopping" },
  [`app update ${RESOURCES[0].uuid}`]: { message: "updated" },
  [`app env create ${RESOURCES[0].uuid}`]: { message: "created" },
  [`app env update ${RESOURCES[0].uuid} NODE_ENV`]: { message: "updated" },
  [`app env update ${RESOURCES[0].uuid} DATABASE_PASSWORD`]: { message: "updated" },
  [`app start ${RESOURCES[1].uuid}`]: { message: "starting" },
  // The real CLI wraps the queued deployment in `{ deployments: [...] }`.
  [`deploy uuid ${RESOURCES[0].uuid}`]: {
    deployments: [{ message: "Deployment request queued.", resource_uuid: RESOURCES[0].uuid, deployment_uuid: "dep1" }],
  },
  // Oldest first on purpose: the wrapper must sort, not trust upstream order.
  [`app deployments list ${RESOURCES[0].uuid}`]: [
    {
      deployment_uuid: "depok0",
      status: "finished",
      commit: SHA,
      commit_message: "feat: a commit message long enough that the history view has to truncate it somewhere",
      created_at: "2026-09-29T09:00:00.000000Z",
      finished_at: "2026-09-29T09:02:05.000000Z",
      logs: JSON.stringify([{ command: null, output: "New container is healthy.", type: "stdout", timestamp: "2026-09-29T09:02:00Z", hidden: false }]),
    },
    DEPLOYMENT,
  ],
  [`deploy get ${DEPLOYMENT.deployment_uuid}`]: DEPLOYMENT,
  "deploy list": [],
  "context list": [
    { name: "hireopz", fqdn: "https://panel.hireopz.com", default: true },
    { name: "cloud", fqdn: "https://app.coolify.io", default: false },
  ],
};

// Tests assert on what the wrapper actually invoked, not just what it returned.
if (process.env.FAKE_COOLIFY_LOG) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.FAKE_COOLIFY_LOG, `${JSON.stringify(argv)}\n`);
}

// Exit 1 with only the banner on stderr, so the wrapper sees execFile's own
// "Command failed: <argv>" message — the path that used to echo flag values.
if (process.env.FAKE_COOLIFY_SILENT_FAIL && key.startsWith(process.env.FAKE_COOLIFY_SILENT_FAIL)) process.exit(1);
if (process.env.FAKE_COOLIFY_FAIL) {
  process.stderr.write(`Error: ${process.env.FAKE_COOLIFY_FAIL}\n`);
  process.exit(1);
}
// `deploy get dep1` reports in_progress for the first two polls, then finished,
// so watch tests exercise the loop. Counting uses the call log.
if (key === "deploy get dep1") {
  const { readFileSync } = await import("node:fs");
  let polls = 1;
  try {
    polls = readFileSync(process.env.FAKE_COOLIFY_LOG, "utf8").split("\n").filter((l) => l.includes('"dep1"')).length;
  } catch {}
  const status = polls <= 2 ? "in_progress" : "finished";
  process.stdout.write(JSON.stringify({ ...DEPLOYMENT, deployment_uuid: "dep1", status, commit: SHA, logs: JSON.stringify([{ command: null, output: "New container is healthy.", type: "stdout", timestamp: "2026-09-30T10:12:00Z", hidden: false }]), finished_at: status === "finished" ? DEPLOYMENT.finished_at : null }));
  process.exit(0);
}
// Upstream `app logs` ignores --format and prints plain text.
if (key === `app logs ${RESOURCES[0].uuid}`) {
  const unique = Array.from({ length: 300 }, (_, i) => `2026-09-30T10:02:00.000Z request ${i} served in ${i}ms`);
  process.stdout.write(`${CONTAINER_LOG}\n${unique.join("\n")}\n`);
  process.exit(0);
}
// Empty deployment history prints plain text, even with --format json.
if (key === `app deployments list ${RESOURCES[1].uuid}`) {
  process.stdout.write("No deployments found for this application\n");
  process.exit(0);
}

// The real CLI answers mutations with a plain-text confirmation rather than
// JSON, so parsing their output would fail an otherwise successful write.
const PLAIN_TEXT = new Set([
  `app update ${RESOURCES[0].uuid}`,
  `app env create ${RESOURCES[0].uuid}`,
  `app env update ${RESOURCES[0].uuid} NODE_ENV`,
  `app env update ${RESOURCES[0].uuid} DATABASE_PASSWORD`,
  `app env delete ${RESOURCES[0].uuid} envnode`,
  `app env delete ${RESOURCES[0].uuid} envpass`,
  `service create n8n`,
  `service delete ${SERVICES[0].uuid}`,
  `service env create ${SERVICES[0].uuid}`,
  `service env update ${SERVICES[0].uuid} PORT`,
  `service env update ${SERVICES[0].uuid} SERVICE_API_TOKEN`,
]);
// `service create --list-types` answers with a plain-text catalogue, even with
// --format json — so the wrapper reads it as text.
if (key === "service create") {
  process.stdout.write("Available one-click service types:\n\n  ghost\n  n8n\n  wordpress-with-mysql\n");
  process.exit(0);
}
if (PLAIN_TEXT.has(key)) {
  process.stdout.write(
    key.startsWith("service") ? "Service command completed successfully\n" : "Environment variable updated successfully\n",
  );
  process.exit(0);
}

if (!(key in TABLE)) {
  process.stderr.write(`Error: unknown command "${key}"\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(TABLE[key]));
