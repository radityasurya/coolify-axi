import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceCommand } from "../src/commands/service.js";
import { fakeApi, recordCalls, restoreApi, useFakeCoolify } from "./helpers.js";

test.beforeEach(useFakeCoolify);
test.afterEach(restoreApi);

const SVC = "svc1".padEnd(24, "x");
const PRJ = "prj1".padEnd(24, "x");
const COMPOSE = [
  "services:",
  "  runner:",
  "    image: myoung34/github-runner:latest",
  "    environment:",
  "      - ACCESS_TOKEN=${ACCESS_TOKEN}",
  "      - RUNNER_TOKEN=s3cr3t-runner-value",
  "      REPO_URL: https://github.com/acme/strategist",
].join("\n");

// What GET /services/{uuid} returns to a read:sensitive token: the compose and
// the destination with its server — including server secrets that must not leak.
const DETAIL = {
  uuid: SVC,
  name: "cAdvisor",
  status: "running:healthy",
  environment_id: 7,
  server_id: 1,
  destination_id: 1,
  docker_compose_raw: COMPOSE,
  destination: {
    uuid: "dst1".padEnd(24, "x"),
    server: { uuid: "srv1".padEnd(24, "x"), settings: { sentinel_token: "SentinelSecret123" } },
  },
};
const PROJECT = {
  uuid: PRJ,
  name: "blog",
  environments: [
    { id: 6, name: "staging", uuid: "env6".padEnd(24, "x") },
    { id: 7, name: "production", uuid: "env7".padEnd(24, "x") },
  ],
};

function composeFile(text) {
  const path = join(mkdtempSync(join(tmpdir(), "coolify-axi-compose-")), "compose.yml");
  writeFileSync(path, text);
  return path;
}

test("list stays projected after the split from infra", async () => {
  const output = await serviceCommand(["list"]);
  assert.equal(output.count, "2 total");
  assert.deepEqual(Object.keys(output.services[0]), ["name", "state", "uuid"]);
});

test("get names the project, environment, server, destination, and env keys a clone needs", async () => {
  fakeApi({ [`GET /services/${SVC}`]: DETAIL, [`GET /projects/${PRJ}`]: PROJECT });
  const output = await serviceCommand(["get", "cAdvisor"]);

  assert.deepEqual(output.service, {
    name: "cAdvisor",
    uuid: SVC,
    status: "running:healthy",
    project: "blog",
    project_uuid: PRJ,
    environment: "production",
    environment_uuid: "env7".padEnd(24, "x"),
    server_uuid: "srv1".padEnd(24, "x"),
    destination_uuid: "dst1".padEnd(24, "x"),
    env_keys: ["PORT", "ACCESS_TOKEN", "SERVICE_API_TOKEN", "DATABASE_URL"],
  });
  const text = JSON.stringify(output);
  assert.doesNotMatch(text, /SentinelSecret123|s3cr3t-runner-value|hunter2/, "no compose and no server secret");
  assert.ok(output.help.some((line) => line.includes("service compose cAdvisor")));
});

test("get says why the server and destination are missing for a token without read:sensitive", async () => {
  const { destination, docker_compose_raw, ...plain } = DETAIL;
  fakeApi({ [`GET /services/${SVC}`]: plain, [`GET /projects/${PRJ}`]: PROJECT });
  const output = await serviceCommand(["get", "cAdvisor"]);

  assert.equal(output.service.project, "blog");
  assert.ok(!("server_uuid" in output.service));
  assert.match(output.note, /read:sensitive/);
});

test("compose prints the source with secrets masked and references kept", async () => {
  fakeApi({ [`GET /services/${SVC}`]: DETAIL });
  const output = await serviceCommand(["compose", "cAdvisor"]);

  assert.equal(output.service, "cAdvisor");
  assert.match(output.compose, /- ACCESS_TOKEN=\$\{ACCESS_TOKEN\}/);
  assert.match(output.compose, /- RUNNER_TOKEN=<redacted>/);
  assert.match(output.compose, /image: myoung34\/github-runner:latest/);
  assert.match(output.compose, /REPO_URL: https:\/\/github.com\/acme\/strategist/);
  assert.doesNotMatch(JSON.stringify(output), /s3cr3t-runner-value|SentinelSecret123/);
});

test("compose without read:sensitive is an auth error, not an empty answer", async () => {
  const { docker_compose_raw, ...plain } = DETAIL;
  fakeApi({ [`GET /services/${SVC}`]: plain });
  await assert.rejects(
    () => serviceCommand(["compose", "cAdvisor"]),
    (error) => error.code === "AUTH_ERROR" && error.suggestions.some((line) => /read:sensitive/.test(line)),
  );
});

test("create from a compose file posts it base64-encoded, with no type", async () => {
  const seen = fakeApi({ "POST /services": { uuid: "new1".padEnd(24, "x"), domains: [] } });
  const calls = recordCalls();
  const output = await serviceCommand([
    "create",
    "--docker-compose-file", composeFile(COMPOSE),
    "--name", "runner-2",
    "--project-uuid", PRJ,
    "--server-uuid", "srv1",
    "--destination-uuid", "dst1",
  ]);

  assert.equal(seen.length, 1);
  const { body } = seen[0];
  assert.equal(Buffer.from(body.docker_compose_raw, "base64").toString("utf8"), COMPOSE);
  assert.ok(!("type" in body), "Coolify refuses a type next to a compose");
  assert.deepEqual(
    { ...body, docker_compose_raw: undefined },
    {
      docker_compose_raw: undefined,
      project_uuid: PRJ,
      server_uuid: "srv1",
      destination_uuid: "dst1",
      environment_name: "production",
      name: "runner-2",
      instant_deploy: false,
    },
  );
  assert.equal(calls().filter((argv) => argv[1] === "create").length, 0, "the wrapped CLI cannot create from compose");
  assert.equal(output.uuid, "new1".padEnd(24, "x"));
  assert.equal(output.name, "runner-2");
  assert.ok(output.help.some((line) => line.includes(`service start ${output.uuid}`)));
});

test("create from a template type posts the type", async () => {
  const seen = fakeApi({ "POST /services": { uuid: "new2".padEnd(24, "x"), domains: ["https://n8n.example"] } });
  const output = await serviceCommand([
    "create", "n8n",
    "--project-uuid", "proj1",
    "--server-uuid", "srv1",
    "--environment-uuid", "env1",
    "--name", "automation",
    "--instant-deploy",
  ]);

  assert.deepEqual(seen[0].body, {
    type: "n8n",
    project_uuid: "proj1",
    server_uuid: "srv1",
    environment_uuid: "env1",
    name: "automation",
    instant_deploy: true,
  });
  assert.equal(output.created, "n8n");
  assert.equal(output.name, "automation");
  assert.equal(output.deploying, true);
  assert.deepEqual(output.domains, ["https://n8n.example"]);
});

for (const [name, argv, pattern] of [
  ["a type and a compose", ["create", "n8n", "--docker-compose", "services: {}", "--project-uuid", "p", "--server-uuid", "s"], /not both/],
  ["neither a type nor a compose", ["create", "--project-uuid", "p", "--server-uuid", "s"], /<type> or --docker-compose-file/],
  ["both compose flags", ["create", "--docker-compose", "x", "--docker-compose-file", "y.yml", "--project-uuid", "p", "--server-uuid", "s"], /not both/],
  ["an empty compose", ["create", "--docker-compose", "  ", "--project-uuid", "p", "--server-uuid", "s"], /empty/],
  ["an unreadable compose file", ["create", "--docker-compose-file", "/nonexistent/compose.yml", "--project-uuid", "p", "--server-uuid", "s"], /cannot read/],
  ["no --project-uuid", ["create", "n8n", "--server-uuid", "s"], /--project-uuid/],
]) {
  test(`create refuses ${name} before any request`, async () => {
    const seen = fakeApi({ "POST /services": { uuid: "x" } });
    const calls = recordCalls();
    await assert.rejects(
      () => serviceCommand(argv),
      (error) => error.code === "VALIDATION_ERROR" && pattern.test(error.message) && error.suggestions.length > 0,
    );
    assert.equal(seen.length, 0);
    assert.equal(calls().length, 0);
  });
}

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

test("a lifecycle command's plain-text answer is a success, not a JSON error", async () => {
  // The real CLI prints "Service starting request queued." whatever --format says.
  const output = await serviceCommand(["restart", "cAdvisor"]);
  assert.equal(output.action, "restart");
});

test("a lifecycle request the instance ignored is reported as a failure", async () => {
  process.env.FAKE_COOLIFY_STDOUT = "This endpoint has changed to a POST request.";
  await assert.rejects(
    () => serviceCommand(["restart", "cAdvisor"]),
    (error) => error.code === "COOLIFY_ERROR" && error.suggestions.some((line) => /coolify update/.test(line)),
  );
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

test("env masks every value except a shared-variable reference", async () => {
  const output = await serviceCommand(["env", "cAdvisor"]);
  const secret = output.env.find((row) => row.key === "SERVICE_API_TOKEN");
  assert.match(secret.value, /redacted/, "the VALUE is the secret, not the variable name");
  assert.equal(secret.key, "SERVICE_API_TOKEN", "the variable name must stay readable");
  assert.equal(output.env.find((row) => row.key === "ACCESS_TOKEN").value, "{{project.ACCESS_TOKEN}}");
  assert.match(output.env.find((row) => row.key === "PORT").value, /redacted/, "an innocent name is no proof");
  assert.doesNotMatch(JSON.stringify(output), /hunter2/, "credentials in connection URLs never print");
  assert.match(output.note, /--reveal/);
});

test("env fetches values in clear so references survive the wrapped CLI's masking", async () => {
  const calls = recordCalls();
  await serviceCommand(["env", "cAdvisor"]);
  assert.ok(calls().find((argv) => argv[2] === "list").includes("--show-sensitive"));
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

test("--set accepts a shared-variable reference as the value", async () => {
  const calls = recordCalls();
  const output = await serviceCommand(["env", "cAdvisor", "--set", "GH_TOKEN={{team.GH_RUNNER_TOKEN}}"]);

  assert.deepEqual(output.env, [{ key: "GH_TOKEN", created: true }]);
  const create = calls().find((argv) => argv[2] === "create");
  assert.equal(create[create.indexOf("--value") + 1], "{{team.GH_RUNNER_TOKEN}}");
});

test("--set to the reference already stored is a no-op", async () => {
  const calls = recordCalls();
  const output = await serviceCommand(["env", "cAdvisor", "--set", "ACCESS_TOKEN={{project.ACCESS_TOKEN}}"]);
  assert.deepEqual(output.env, [{ key: "ACCESS_TOKEN", unchanged: true }]);
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

test("domain sets the URLs of one sub-service through the API", async () => {
  const seen = fakeApi({ [`PATCH /services/${"svc1".padEnd(24, "x")}`]: { message: "ok" } });
  try {
    const output = await serviceCommand(["domain", "cAdvisor", "--service", "cadvisor", "https://a.example,https://www.a.example"]);
    assert.deepEqual(seen[0].body, { urls: [{ name: "cadvisor", url: "https://a.example,https://www.a.example" }] });
    assert.deepEqual(output.domains, ["https://a.example", "https://www.a.example"]);
    await assert.rejects(() => serviceCommand(["domain", "cAdvisor", "https://a.example"]), (e) => e.code === "VALIDATION_ERROR" && /--service/.test(e.message));
    await assert.rejects(() => serviceCommand(["domain", "cAdvisor", "--service", "cadvisor"]), (e) => e.code === "VALIDATION_ERROR");
  } finally {
    restoreApi();
  }
});
