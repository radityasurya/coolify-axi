import test from "node:test";
import assert from "node:assert/strict";
import { projectCommand, sharedEnvCommand } from "../src/commands/infra.js";
import { fakeApi, recordCalls, restoreApi, useFakeCoolify } from "./helpers.js";

test.beforeEach(useFakeCoolify);
test.afterEach(restoreApi);

const PRJ = "prj1".padEnd(24, "x");

test("project list shows each project's name and uuid", async () => {
  const output = await projectCommand(["list"]);
  assert.equal(output.count, "1 total");
  assert.deepEqual(output.projects, [{ name: "blog", uuid: PRJ }]);
  assert.ok(output.help.some((line) => line.includes("project get")));
});

test("project get lists environments with id, name, and uuid", async () => {
  const seen = fakeApi({
    [`GET /projects/${PRJ}`]: {
      uuid: PRJ,
      name: "blog",
      environments: [{ id: 7, name: "production", uuid: "env7".padEnd(24, "x"), project_id: 1, created_at: "x" }],
    },
  });
  const output = await projectCommand(["get", "blog"]);

  assert.equal(seen[0].key, `GET /projects/${PRJ}`);
  assert.deepEqual(output.project, { name: "blog", uuid: PRJ });
  assert.deepEqual(output.environments, [{ id: 7, name: "production", uuid: "env7".padEnd(24, "x") }]);
  assert.ok(output.help.some((line) => line.includes("shared-env --project blog")));
});

test("project get on a miss raises NOT_FOUND before any API call", async () => {
  const seen = fakeApi({});
  await assert.rejects(() => projectCommand(["get", "nope"]), (error) => error.code === "NOT_FOUND");
  assert.equal(seen.length, 0);
});

test("shared-env lists team keys with their reference, never a value", async () => {
  const output = await sharedEnvCommand([]);
  assert.equal(output.scope, "team");
  assert.deepEqual(output.variables, [{ key: "GH_RUNNER_TOKEN", ref: "{{team.GH_RUNNER_TOKEN}}" }]);
  assert.doesNotMatch(JSON.stringify(output), /TeamSecretValue/);
});

test("shared-env --project resolves the name and reads project scope", async () => {
  const calls = recordCalls();
  const output = await sharedEnvCommand(["--project", "blog"]);
  assert.equal(output.scope, "project");
  assert.deepEqual(output.variables, [{ key: "ACCESS_TOKEN", ref: "{{project.ACCESS_TOKEN}}" }]);
  assert.deepEqual(calls().at(-1).slice(0, 4), ["shared-env", "project", "list", PRJ]);
});

test("shared-env --project --environment reads environment scope", async () => {
  const output = await sharedEnvCommand(["list", "--project", "blog", "--environment", "production"]);
  assert.equal(output.scope, "environment");
  assert.deepEqual(output.variables, [{ key: "DB_URL", ref: "{{environment.DB_URL}}" }]);
});

test("shared-env states an empty scope definitively", async () => {
  const output = await sharedEnvCommand(["--project", "blog", "--environment", "staging"]);
  assert.equal(output.variables, "0 environment shared variables");
});

test("shared-env --environment without --project fails before any shell-out", async () => {
  const calls = recordCalls();
  await assert.rejects(
    () => sharedEnvCommand(["--environment", "production"]),
    (error) => error.code === "VALIDATION_ERROR" && /--project/.test(error.message),
  );
  assert.equal(calls().length, 0);
});
