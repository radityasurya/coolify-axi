#!/usr/bin/env node
// Stands in for the real `coolify` binary. Responds to argv with canned JSON and
// always emits the update banner on stderr, so the wrapper's stderr filtering
// and JSON parsing are exercised for real rather than mocked away.
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

const TABLE = {
  "resource list": RESOURCES,
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
  [`app logs ${RESOURCES[0].uuid}`]: { logs: "x".repeat(9000) },
  [`app env list ${RESOURCES[0].uuid}`]: [
    { key: "NODE_ENV", value: "production", is_build_time: false },
    { key: "DATABASE_PASSWORD", value: "hunter2", is_build_time: false },
  ],
  [`app stop ${RESOURCES[0].uuid}`]: { message: "stopping" },
  [`app start ${RESOURCES[1].uuid}`]: { message: "starting" },
  [`deploy uuid ${RESOURCES[0].uuid}`]: [{ deployment_uuid: "dep1", message: "queued" }],
  "deploy list": [],
  "context list": [
    { name: "hireopz", fqdn: "https://panel.hireopz.com", default: true },
    { name: "cloud", fqdn: "https://app.coolify.io", default: false },
  ],
};

if (process.env.FAKE_COOLIFY_FAIL) {
  process.stderr.write(`Error: ${process.env.FAKE_COOLIFY_FAIL}\n`);
  process.exit(1);
}
if (!(key in TABLE)) {
  process.stderr.write(`Error: unknown command "${key}"\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(TABLE[key]));
