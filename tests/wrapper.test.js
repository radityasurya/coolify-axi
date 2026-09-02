import test from "node:test";
import assert from "node:assert/strict";
import { contextCommand } from "../src/commands/context.js";
import { dbCommand } from "../src/commands/db.js";
import { deployCommand } from "../src/commands/deploy.js";
import { coolify, health, redact, summarize } from "../src/coolify.js";
import { useFakeCoolify } from "./helpers.js";

test.beforeEach(useFakeCoolify);

test("the wrapped CLI's update banner never reaches stdout", async () => {
  const rows = await coolify(["resource", "list"]);
  assert.ok(Array.isArray(rows), "a stderr banner must not corrupt JSON parsing");
  assert.equal(rows.length, 5);
});

test("a missing binary is an install hint, not a stack trace", async () => {
  process.env.COOLIFY_AXI_BIN = "/nonexistent/coolify";
  await assert.rejects(
    () => coolify(["resource", "list"]),
    (error) => error.code === "MISSING_DEPENDENCY" && /not on PATH/.test(error.message),
  );
});

test("health splits Coolify's compound status", () => {
  assert.deepEqual(health("running:healthy"), { state: "running", health: "healthy" });
  assert.deepEqual(health("exited"), { state: "exited", health: "" });
});

test("summarize pre-computes the state rollup", () => {
  assert.equal(
    summarize([{ status: "running:healthy" }, { status: "running:healthy" }, { status: "exited" }]),
    "2 running, 1 exited",
  );
});

test("redact catches password, secret, token, and key shapes", () => {
  const out = redact({ postgres_password: "x", api_token: "y", name: "keep", ssh_key: "z" });
  assert.match(out.postgres_password, /redacted/);
  assert.match(out.api_token, /redacted/);
  assert.match(out.ssh_key, /redacted/);
  assert.equal(out.name, "keep");
});

test("db get redacts connection secrets by default", async () => {
  const output = await dbCommand(["get", "blogs-pg"]);
  assert.match(output.database.postgres_password, /redacted/);
  assert.match(output.database.internal_db_url, /redacted/);
  assert.equal(output.database.postgres_user, "postgres");
});

test("a password embedded in a connection URL is redacted even under an innocent key", () => {
  const out = redact({ internal_db_url: "postgres://user:hunter2@host:5432/db" });
  assert.equal(out.internal_db_url, "postgres://user:<redacted>@host:5432/db");
  assert.ok(!out.internal_db_url.includes("hunter2"));
});

test("db get --reveal prints them", async () => {
  const output = await dbCommand(["get", "blogs-pg", "--reveal"]);
  assert.equal(output.database.postgres_password, "hunter2");
  assert.ok(!("note" in output));
});

test("deploy <name> is shorthand for deploy run <name>", async () => {
  const output = await deployCommand(["digivaley"]);
  assert.equal(output.deploying, "digivaley");
  assert.equal(output.deployment, "dep1");
});

test("an empty deploy list states the zero", async () => {
  const output = await deployCommand(["list"]);
  assert.match(output.deployments, /^0 deployments/);
});

test("context reports which instance is active", async () => {
  const output = await contextCommand([]);
  assert.equal(output.active, "hireopz");
  assert.equal(output.contexts.length, 2);
});
