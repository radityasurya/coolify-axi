import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCommand } from "../src/commands/app.js";
import { failWith, fakeApi, recordCalls, restoreApi, useFakeCoolify } from "./helpers.js";

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

test("logs read plain text, collapse the flood, redact, and truncate with a size hint", async () => {
  const output = await appCommand(["logs", "digivaley"]);
  assert.match(output.truncated, /of \d+ chars/);
  assert.ok(output.help.some((line) => line.includes("--full")));
  assert.doesNotMatch(JSON.stringify(output), /hunter2|eyJhbGci/);
});

test("--full returns the whole redacted log with repeats collapsed", async () => {
  const output = await appCommand(["logs", "digivaley", "--full"]);
  assert.ok(!("truncated" in output));
  assert.ok(Array.isArray(output.logs), "one array entry per line so agents can grep");
  assert.ok(output.logs.every((line) => !line.includes("\n")));
  assert.match(output.logs.join("\n"), /ECONNREFUSED 10\.0\.1\.5:6379 \[x40\]/);
  assert.match(output.logs.join("\n"), /postgres:\/\/u:<redacted>@db\/x/);
  assert.doesNotMatch(output.logs.join("\n"), /hunter2|eyJhbGci/);
});

test("--grep filters case-insensitively before collapsing", async () => {
  const output = await appCommand(["logs", "digivaley", "--grep", "econnrefused|listening"]);
  assert.equal(output.lines, "2 shown of 344 fetched");
  assert.match(output.logs.join("\n"), /\[x40\]/);
  assert.ok(output.help.some((line) => line.includes("--lines")), "short output still carries a hint");
});

test("--grep with no match says so definitively", async () => {
  const output = await appCommand(["logs", "digivaley", "--grep", "segfault ("]);
  assert.match(output.logs, /0 of 344 lines match/);
});

test("--keep-repeats leaves the flood uncollapsed", async () => {
  const output = await appCommand(["logs", "digivaley", "--full", "--keep-repeats", "--grep", "ECONNREFUSED"]);
  assert.equal(output.lines, "40 shown of 344 fetched");
});

test("env masks every value except a shared-variable reference", async () => {
  const output = await appCommand(["env", "digivaley"]);
  const secret = output.env.find((row) => row.key === "DATABASE_PASSWORD");
  assert.match(secret.value, /redacted/, "the VALUE is the secret, not the variable name");
  assert.equal(secret.key, "DATABASE_PASSWORD", "the variable name must stay readable");
  assert.match(output.env.find((row) => row.key === "NODE_ENV").value, /redacted/);
  assert.equal(output.env.find((row) => row.key === "SHARED_DSN").value, "{{ environment.SENTRY_DSN }}");
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

test("app create from a private repository resolves the deploy key by name", async () => {
  const calls = recordCalls();
  const output = await appCommand(["create", "web", "--repo", "git@github.com:acme/web.git", "--branch", "main", "--server", "localhost", "--project", "blog", "--deploy-key", "coolify-hireopz"]);
  const create = calls().find((argv) => argv[1] === "create");
  assert.deepEqual(create.slice(0, 5), ["app", "create", "deploy-key", "--private-key-uuid", "key1".padEnd(24, "x")]);
  assert.ok(create.includes("git@github.com:acme/web.git"));
  assert.equal(output.created.uuid, "newapp".padEnd(24, "x"));
});

test("app create --destination passes the destination uuid through", async () => {
  const calls = recordCalls();
  await appCommand(["create", "web", "--repo", "git@github.com:acme/web.git", "--branch", "main", "--server", "localhost", "--project", "blog", "--deploy-key", "coolify-hireopz", "--destination", "dest1"]);
  const create = calls().find((argv) => argv[1] === "create");
  assert.equal(create[create.indexOf("--destination-uuid") + 1], "dest1");
});

test("app create --deploy-key validation", async () => {
  const calls = recordCalls();
  const base = ["create", "web", "--branch", "main", "--server", "localhost", "--project", "blog"];
  await assert.rejects(() => appCommand([...base, "--repo", "acme/web", "--deploy-key", "k"]), (e) => e.code === "VALIDATION_ERROR" && /SSH URL/.test(e.message));
  await assert.rejects(() => appCommand([...base, "--repo", "git@h:a/b.git", "--deploy-key", "k", "--github-app", "g"]), (e) => e.code === "VALIDATION_ERROR");
  assert.equal(calls().length, 0);
  await assert.rejects(() => appCommand([...base, "--repo", "git@h:a/b.git", "--deploy-key", "nope"]), (e) => e.code === "NOT_FOUND");
});

test("app domain --service patches docker_compose_domains through the API", async () => {
  const seen = fakeApi({ [`PATCH /applications/${"app1".padEnd(24, "x")}`]: { message: "ok" } });
  const calls = recordCalls();
  try {
    const output = await appCommand(["domain", "digivaley", "--service", "wordpress", "https://a.example,https://www.a.example"]);
    assert.deepEqual(seen[0].body, { docker_compose_domains: [{ name: "wordpress", domain: "https://a.example,https://www.a.example" }] });
    assert.deepEqual(output.domains, ["https://a.example", "https://www.a.example"]);
    assert.equal(calls().filter((argv) => argv[0] === "app" && argv[1] === "update").length, 0);
    await assert.rejects(() => appCommand(["domain", "digivaley", "--service", "wordpress"]), (e) => e.code === "VALIDATION_ERROR");
    await assert.rejects(() => appCommand(["domain", "digivaley", "--service", "a b", "https://x"]), (e) => e.code === "VALIDATION_ERROR");
    await assert.rejects(() => appCommand(["domain", "digivaley", "--service", "w", "--add", "https://x", "https://y"]), (e) => e.code === "VALIDATION_ERROR");
  } finally {
    restoreApi();
  }
});

test("get shows base directory and health check settings", async () => {
  const { app } = await appCommand(["get", "digivaley"]);
  assert.equal(app.base_directory, "/web");
  assert.equal(app.dockerfile_location, "/Dockerfile");
  assert.equal(app.health_check_enabled, false);
  assert.equal(app.health_check_path, "/up");
});

test("domain --clear empties the list on purpose, and only on its own", async () => {
  const calls = recordCalls();
  const output = await appCommand(["domain", "digivaley", "--clear"]);
  const update = calls().find((argv) => argv[1] === "update");
  assert.equal(update[update.indexOf("--domains") + 1], "");
  assert.deepEqual(output.domains, []);
  assert.deepEqual(output.removed, ["https://digivaley.com"]);
  await assert.rejects(() => appCommand(["domain", "digivaley", "--clear", "--add", "https://x"]), (e) => e.code === "VALIDATION_ERROR");
});

const b64 = (text) => Buffer.from(text).toString("base64");
const LABELS = ["traefik.enable=true", "traefik.http.middlewares.a.basicauth.users=admin:$apr1$secret", "x=1"].join("\n");
const APP_PATH = `/applications/${"app1".padEnd(24, "x")}`;

test("labels shows decoded labels and redacts auth values", async () => {
  const seen = fakeApi({ [`GET ${APP_PATH}`]: { custom_labels: b64(LABELS) } });
  try {
    const output = await appCommand(["labels", "digivaley"]);
    assert.deepEqual(output.labels, ["traefik.enable=true", "traefik.http.middlewares.a.basicauth.users=<redacted>", "x=1"]);
    assert.doesNotMatch(JSON.stringify(output), /secret/);
    assert.equal(seen.length, 1);
  } finally {
    restoreApi();
  }
});

test("labels --add replaces a key, --remove drops one, and PATCH sends custom_labels only", async () => {
  const seen = fakeApi({ [`GET ${APP_PATH}`]: { custom_labels: b64(LABELS) }, [`PATCH ${APP_PATH}`]: { message: "ok" } });
  try {
    const output = await appCommand(["labels", "digivaley", "--add", "x=2", "--add", "new=a=b", "--remove", "traefik.enable"]);
    const patch = seen.find((r) => r.key.startsWith("PATCH"));
    assert.deepEqual(Object.keys(patch.body), ["custom_labels"]);
    assert.equal(Buffer.from(patch.body.custom_labels, "base64").toString(), "traefik.http.middlewares.a.basicauth.users=admin:$apr1$secret\nx=2\nnew=a=b");
    assert.ok(output.help.some((line) => line.includes("deploy")));
    assert.doesNotMatch(JSON.stringify(output), /secret/);
  } finally {
    restoreApi();
  }
});

test("labels with no change sends no PATCH", async () => {
  const seen = fakeApi({ [`GET ${APP_PATH}`]: { custom_labels: b64(LABELS) } });
  try {
    const output = await appCommand(["labels", "digivaley", "--add", "x=1", "--remove", "absent"]);
    assert.equal(output.unchanged, true);
    assert.equal(seen.filter((r) => r.key.startsWith("PATCH")).length, 0);
  } finally {
    restoreApi();
  }
});

test("labels --set-file replaces everything", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "coolify-axi-labels-")), "labels.txt");
  writeFileSync(file, "a=1\n\nb=2\n");
  const seen = fakeApi({ [`GET ${APP_PATH}`]: { custom_labels: b64(LABELS) }, [`PATCH ${APP_PATH}`]: { message: "ok" } });
  try {
    await appCommand(["labels", "digivaley", "--set-file", file]);
    const patch = seen.find((r) => r.key.startsWith("PATCH"));
    assert.equal(Buffer.from(patch.body.custom_labels, "base64").toString(), "a=1\nb=2");
    await assert.rejects(() => appCommand(["labels", "digivaley", "--set-file", file, "--add", "a=1"]), (e) => e.code === "VALIDATION_ERROR");
    await assert.rejects(() => appCommand(["labels", "digivaley", "--add", "novalue"]), (e) => e.code === "VALIDATION_ERROR");
  } finally {
    restoreApi();
  }
});
