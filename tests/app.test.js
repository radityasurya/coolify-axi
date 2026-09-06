import test from "node:test";
import assert from "node:assert/strict";
import { appCommand } from "../src/commands/app.js";
import { failWith, recordCalls, useFakeCoolify } from "./helpers.js";

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

test("domain with no change argument reports what the app serves today", async () => {
  const output = await appCommand(["domain", "digivaley"]);
  assert.deepEqual(output.domains, ["https://digivaley.com"]);
});

test("--add keeps the existing domains alongside the new one", async () => {
  const calls = recordCalls();
  const output = await appCommand(["domain", "digivaley", "--add", "https://new.example"]);

  assert.deepEqual(output.domains, ["https://digivaley.com", "https://new.example"]);
  const update = calls().find((argv) => argv[1] === "update");
  // Dropping the original domain here would take the live site off the internet.
  assert.equal(update[update.indexOf("--domains") + 1], "https://digivaley.com,https://new.example");
});

test("adding a domain that is already served is a no-op that never shells out", async () => {
  const calls = recordCalls();
  const output = await appCommand(["domain", "digivaley", "--add", "https://digivaley.com"]);

  assert.equal(output.unchanged, true);
  assert.equal(calls().filter((argv) => argv[1] === "update").length, 0);
});

test("replacing the domain list names what it removed", async () => {
  const output = await appCommand(["domain", "digivaley", "https://only.example"]);
  assert.deepEqual(output.domains, ["https://only.example"]);
  assert.deepEqual(output.removed, ["https://digivaley.com"]);
});

test("removing the last domain is refused rather than silently unrouting the app", async () => {
  const calls = recordCalls();
  await assert.rejects(
    () => appCommand(["domain", "digivaley", "--remove", "https://digivaley.com"]),
    (error) => {
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.match(error.suggestions.join(" "), /stop routing/);
      return true;
    },
  );
  assert.equal(calls().filter((argv) => argv[1] === "update").length, 0);
});

test("--set updates an existing variable and creates a new one", async () => {
  const calls = recordCalls();
  const output = await appCommand([
    "env", "digivaley",
    "--set", "NODE_ENV=staging",
    "--set", "NEXT_PUBLIC_APP_URL=https://new.example",
  ]);

  assert.deepEqual(output.env, [
    { key: "NODE_ENV", updated: true },
    { key: "NEXT_PUBLIC_APP_URL", created: true },
  ]);
  const verbs = calls().filter((argv) => argv[1] === "env").map((argv) => argv[2]);
  assert.deepEqual(verbs, ["list", "update", "create"]);
});

test("--set to the value already stored is a no-op", async () => {
  const calls = recordCalls();
  const output = await appCommand(["env", "digivaley", "--set", "NODE_ENV=production"]);

  assert.deepEqual(output.env, [{ key: "NODE_ENV", unchanged: true }]);
  assert.equal(calls().filter((argv) => argv[2] === "update").length, 0);
});

test("--set never echoes the value back", async () => {
  const output = await appCommand(["env", "digivaley", "--set", "API_TOKEN=super-secret"]);
  assert.doesNotMatch(JSON.stringify(output), /super-secret/);
});

test("a --set without an = is rejected", async () => {
  await assert.rejects(() => appCommand(["env", "digivaley", "--set", "NODE_ENV"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
});
