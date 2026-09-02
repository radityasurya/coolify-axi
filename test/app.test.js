import test from "node:test";
import assert from "node:assert/strict";
import { appCommand } from "../src/commands/app.js";
import { failWith, useFakeCoolify } from "./helpers.js";

test.beforeEach(useFakeCoolify);

test("list projects away the noise and rolls up state", async () => {
  const output = await appCommand(["list"]);
  assert.equal(output.count, "4 total");
  assert.match(output.summary, /running/);
  assert.deepEqual(Object.keys(output.apps[0]), ["name", "state", "health", "uuid"]);
});

test("--status filters on the parsed state, not the raw string", async () => {
  const output = await appCommand(["list", "--status", "exited"]);
  assert.equal(output.apps.length, 1);
  assert.equal(output.apps[0].name, "karja-nl");
});

test("get resolves a name to a uuid and drops the base64 label noise", async () => {
  const output = await appCommand(["get", "digivaley"]);
  assert.equal(output.app.fqdn, "https://digivaley.com");
  assert.ok(!("custom_labels" in output.app), "build plumbing must not reach the agent");
});

test("an ambiguous name lists the candidates instead of guessing", async () => {
  await assert.rejects(
    () => appCommand(["get", "twin"]),
    (error) => error.code === "VALIDATION_ERROR" && /2 resources are named twin/.test(error.message),
  );
});

test("a missing name suggests near matches", async () => {
  await assert.rejects(
    () => appCommand(["get", "digi"]),
    (error) => error.code === "NOT_FOUND" && error.suggestions.some((s) => s.includes("digivaley")),
  );
});

test("logs truncate with a size hint and name the escape hatch", async () => {
  const output = await appCommand(["logs", "digivaley"]);
  assert.match(output.truncated, /of 9000 chars/);
  assert.ok(output.help.some((line) => line.includes("--full")));
  assert.ok(output.logs.length < 9000);
});

test("--full returns the whole log", async () => {
  const output = await appCommand(["logs", "digivaley", "--full"]);
  assert.equal(output.logs.length, 9000);
  assert.ok(!("truncated" in output));
});

test("env redacts secret-shaped values by default", async () => {
  const output = await appCommand(["env", "digivaley"]);
  const secret = output.env.find((row) => row.key === "DATABASE_PASSWORD");
  assert.match(secret.value, /redacted/, "the VALUE is the secret, not the variable name");
  assert.equal(secret.key, "DATABASE_PASSWORD", "the variable name must stay readable");
  assert.equal(output.env.find((row) => row.key === "NODE_ENV").value, "production");
});

test("env --reveal prints the real value", async () => {
  const output = await appCommand(["env", "digivaley", "--reveal"]);
  assert.equal(output.env.find((row) => row.key === "DATABASE_PASSWORD").value, "hunter2");
});

test("starting an already-running app is a no-op", async () => {
  const output = await appCommand(["start", "digivaley"]);
  assert.equal(output.unchanged, true);
  assert.match(output.note, /no-op/);
});

test("stopping a running app actually calls through", async () => {
  const output = await appCommand(["stop", "digivaley"]);
  assert.equal(output.action, "stop");
  assert.equal(output.previous, "running");
});

test("a wrapped-CLI auth failure becomes a structured auth error", async () => {
  failWith("unauthorized: invalid token");
  await assert.rejects(
    () => appCommand(["list"]),
    (error) => error.code === "AUTH_ERROR" && error.suggestions.some((s) => s.includes("context")),
  );
});
