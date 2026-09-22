import test from "node:test";
import assert from "node:assert/strict";
import { serviceCommand } from "../src/commands/service.js";
import { recordCalls, useFakeCoolify } from "./helpers.js";

test.beforeEach(useFakeCoolify);

test("list stays projected after the split from infra", async () => {
  const output = await serviceCommand(["list"]);
  assert.equal(output.count, "2 total");
  assert.deepEqual(Object.keys(output.services[0]), ["name", "state", "uuid"]);
});

test("get resolves a name and keeps the compose source out of the detail", async () => {
  const output = await serviceCommand(["get", "cAdvisor"]);
  assert.equal(output.service.name, "cAdvisor");
  assert.ok(!("docker_compose" in output.service), "the compose source must not reach the agent");
});

test("create sends the raw CLI's own flag names", async () => {
  const calls = recordCalls();
  const output = await serviceCommand([
    "create", "n8n",
    "--project-uuid", "proj1",
    "--server-uuid", "srv1",
    "--environment-name", "production",
    "--name", "automation",
    "--instant-deploy",
  ]);

  const create = calls().find((argv) => argv[1] === "create");
  assert.deepEqual(
    create.slice(0, 6),
    ["service", "create", "n8n", "--project-uuid", "proj1", "--server-uuid"],
  );
  assert.equal(create[create.indexOf("--server-uuid") + 1], "srv1");
  assert.equal(create[create.indexOf("--environment-name") + 1], "production");
  assert.equal(create[create.indexOf("--name") + 1], "automation");
  assert.ok(create.includes("--instant-deploy"));
  assert.equal(output.created, "n8n");
  assert.equal(output.name, "automation");
  assert.equal(output.deploying, true);
});

test("--docker-compose passes literal compose content under the raw CLI's flag", async () => {
  const calls = recordCalls();
  const compose = "services:\n  n8n:\n    image: docker.n8n.io/n8nio/n8n";
  await serviceCommand([
    "create", "n8n",
    "--project-uuid", "p",
    "--server-uuid", "s",
    "--docker-compose", compose,
  ]);

  const create = calls().find((argv) => argv[1] === "create");
  assert.equal(create[create.indexOf("--docker-compose") + 1], compose);
});

test("create without --project-uuid fails before any shell-out", async () => {
  const calls = recordCalls();
  await assert.rejects(
    () => serviceCommand(["create", "n8n", "--server-uuid", "s"]),
    (error) => error.code === "VALIDATION_ERROR" && /--project-uuid/.test(error.message),
  );
  assert.equal(calls().length, 0);
});

test("passing both environment selectors is refused", async () => {
  const calls = recordCalls();
  await assert.rejects(
    () =>
      serviceCommand([
        "create", "n8n",
        "--project-uuid", "p",
        "--server-uuid", "s",
        "--environment-name", "production",
        "--environment-uuid", "env1",
      ]),
    (error) => error.code === "VALIDATION_ERROR" && /not both/.test(error.message),
  );
  assert.equal(calls().length, 0);
});

test("--list-types prints the catalogue without the wrapped CLI's header", async () => {
  const output = await serviceCommand(["create", "--list-types"]);
  assert.deepEqual(output.types, ["ghost", "n8n", "wordpress-with-mysql"]);
  assert.match(output.count, /3 types/);
});

test("delete without --yes names the target and never shells out", async () => {
  const calls = recordCalls();
  await assert.rejects(
    () => serviceCommand(["delete", "cAdvisor"]),
    (error) => {
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.match(error.message, /--yes/);
      assert.match(error.message, /cAdvisor/);
      return true;
    },
  );
  assert.equal(calls().filter((argv) => argv[1] === "delete").length, 0);
});

test("delete --yes resolves the name and forces the raw delete", async () => {
  const calls = recordCalls();
  const output = await serviceCommand(["delete", "cAdvisor", "--yes"]);

  assert.equal(output.deleted, "cAdvisor");
  const del = calls().find((argv) => argv[1] === "delete");
  assert.deepEqual(del.slice(0, 4), ["service", "delete", "svc1".padEnd(24, "x"), "--force"]);
});

test("starting an already-running service is a no-op", async () => {
  const calls = recordCalls();
  const output = await serviceCommand(["start", "cAdvisor"]);
  assert.equal(output.unchanged, true);
  assert.match(output.note, /no-op/);
  assert.equal(calls().filter((argv) => argv[1] === "start").length, 0);
});

test("stopping a running service actually calls through", async () => {
  const calls = recordCalls();
  const output = await serviceCommand(["stop", "cAdvisor"]);
  assert.equal(output.action, "stop");
  assert.equal(output.previous, "running");
  const stop = calls().find((argv) => argv[1] === "stop");
  assert.deepEqual(stop.slice(0, 3), ["service", "stop", "svc1".padEnd(24, "x")]);
});

test("starting a stopped service calls through", async () => {
  const output = await serviceCommand(["start", "umami"]);
  assert.equal(output.action, "start");
  assert.equal(output.previous, "exited");
});

test("restart always calls through", async () => {
  const calls = recordCalls();
  const output = await serviceCommand(["restart", "cAdvisor"]);
  assert.equal(output.action, "restart");
  assert.equal(calls().filter((argv) => argv[1] === "restart").length, 1);
});

test("env redacts secret-shaped values by default", async () => {
  const output = await serviceCommand(["env", "cAdvisor"]);
  const secret = output.env.find((row) => row.key === "SERVICE_API_TOKEN");
  assert.match(secret.value, /redacted/, "the VALUE is the secret, not the variable name");
  assert.equal(secret.key, "SERVICE_API_TOKEN", "the variable name must stay readable");
  assert.equal(output.env.find((row) => row.key === "PORT").value, "8080");
  assert.match(output.note, /--reveal/);
});

test("env scrubs credentials embedded in connection URLs", async () => {
  const output = await serviceCommand(["env", "cAdvisor"]);
  assert.equal(
    output.env.find((row) => row.key === "DATABASE_URL").value,
    "postgres://svc:<redacted>@db/svc",
  );
});

test("env --reveal threads --show-sensitive through to the wrapped CLI", async () => {
  const calls = recordCalls();
  const output = await serviceCommand(["env", "cAdvisor", "--reveal"]);

  assert.equal(output.env.find((row) => row.key === "SERVICE_API_TOKEN").value, "hunter2");
  assert.ok(calls().find((argv) => argv[1] === "env").includes("--show-sensitive"));
  assert.ok(!("note" in output));
});

test("--set updates an existing variable and creates a new one", async () => {
  const calls = recordCalls();
  const output = await serviceCommand([
    "env", "cAdvisor",
    "--set", "PORT=1234",
    "--set", "NEW_KEY=value",
  ]);

  assert.deepEqual(output.env, [
    { key: "PORT", updated: true },
    { key: "NEW_KEY", created: true },
  ]);
  const verbs = calls().filter((argv) => argv[1] === "env").map((argv) => argv[2]);
  assert.deepEqual(verbs, ["list", "update", "create"]);
});

test("--set to the value already stored is a no-op", async () => {
  const calls = recordCalls();
  const output = await serviceCommand(["env", "cAdvisor", "--set", "PORT=8080"]);

  assert.deepEqual(output.env, [{ key: "PORT", unchanged: true }]);
  assert.equal(calls().filter((argv) => argv[2] === "update").length, 0);
});

test("--set never echoes the value back", async () => {
  const output = await serviceCommand(["env", "cAdvisor", "--set", "SERVICE_API_TOKEN=super-secret"]);
  assert.doesNotMatch(JSON.stringify(output), /super-secret/);
});

test("a --set without an = is rejected", async () => {
  await assert.rejects(() => serviceCommand(["env", "cAdvisor", "--set", "PORT"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    return true;
  });
});
