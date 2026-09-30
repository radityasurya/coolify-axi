import test from "node:test";
import assert from "node:assert/strict";
import { deployCommand, timing } from "../src/commands/deploy.js";
import { recordCalls, useFakeCoolify } from "./helpers.js";
import { SECRETS, SHA } from "./fixtures/deployment-log.mjs";

test.beforeEach(useFakeCoolify);

// Polling must never really wait: a fake clock advances on every sleep.
let clock = 0;
const slept = [];
test.beforeEach(() => {
  clock = 0;
  slept.length = 0;
  timing.now = () => clock;
  timing.sleep = async (ms) => {
    slept.push(ms);
    clock += ms;
  };
});

function assertNoSecrets(output) {
  const text = JSON.stringify(output);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 6)}…`);
}

test("deploy <name> reads the uuid out of the { deployments: [...] } shape", async () => {
  const output = await deployCommand(["digivaley"]);
  assert.equal(output.deployment, "dep1");
  assert.ok(output.help.some((line) => line.includes("deploy watch digivaley dep1")));
});

test("deploy history lists newest first with a resolved SHA for HEAD deploys", async () => {
  const output = await deployCommand(["history", "digivaley"]);
  assert.equal(output.count, "2 of 2 total");
  const [latest, older] = output.deployments;
  assert.equal(latest.uuid, "depfail1");
  assert.equal(latest.status, "failed");
  assert.equal(latest.commit, SHA.slice(0, 7), "HEAD is swapped for the SHA found in the log");
  assert.equal(latest.duration, "3m25s");
  assert.equal(older.commit, SHA.slice(0, 7));
  assert.ok(older.message.length <= 61, "commit messages are truncated");
  assert.ok(!("logs" in latest), "the raw log never reaches the list");
  assertNoSecrets(output);
});

test("deploy history --limit caps the rows and says how many exist", async () => {
  const output = await deployCommand(["history", "digivaley", "--limit", "1"]);
  assert.equal(output.count, "1 of 2 total");
  assert.ok(output.help.some((line) => line.includes("--limit")));
});

test("deploy history on an app with none is a definitive empty state", async () => {
  const output = await deployCommand(["history", "karja-nl"]);
  assert.match(output.deployments, /0 deployments/);
});

test("deploy logs summarizes the latest deployment's failure without leaking secrets", async () => {
  const output = await deployCommand(["logs", "digivaley"]);
  assert.equal(output.deployment, "depfail1");
  assert.match(output.reason, /pre-deployment command failed \(exit code 1\): .*EACCES/);
  assert.match(output.failed_command, /pnpm db:migrate/);
  assert.ok(output.help.some((line) => line.includes("--full")));
  assertNoSecrets(output);
});

test("deploy logs --full --debug prints the whole redacted log, repeats collapsed", async () => {
  const output = await deployCommand(["logs", "digivaley", "depfail1", "--full", "--debug"]);
  assert.match(output.log, /--build-arg DATABASE_URL=<redacted>/);
  assert.match(output.log, /\$ docker exec app-1 sh -c 'pnpm db:migrate'/);
  assertNoSecrets(output);
});

test("deploy logs has no --reveal", async () => {
  await assert.rejects(() => deployCommand(["logs", "digivaley", "--reveal"]), (error) => error.code === "VALIDATION_ERROR");
});

test("deploy watch polls until the deployment leaves in_progress, then summarizes", async () => {
  const calls = recordCalls();
  const output = await deployCommand(["watch", "digivaley", "dep1", "--interval", "2"]);
  assert.equal(output.status, "finished");
  assert.deepEqual(slept, [2000, 2000]);
  assert.equal(calls().filter((argv) => argv[0] === "deploy" && argv[1] === "get").length, 3);
});

test("deploy watch gives up at --timeout and says how to keep watching", async () => {
  recordCalls();
  const output = await deployCommand(["watch", "digivaley", "dep1", "--interval", "5", "--timeout", "5"]);
  assert.equal(output.status, "in_progress");
  assert.match(output.timed_out, /5s/);
  assert.ok(output.help.some((line) => line.includes("deploy watch digivaley dep1")));
});

test("deploy run --wait triggers, then watches to completion", async () => {
  recordCalls();
  const output = await deployCommand(["run", "digivaley", "--wait", "--interval", "1"]);
  assert.equal(output.deployment, "dep1");
  assert.equal(output.status, "finished");
});

test("new subcommands are not swallowed as resource names", async () => {
  const output = await deployCommand(["history", "--help"]);
  assert.equal(output.command, "deploy history");
});
