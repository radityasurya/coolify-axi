import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appCommand, io } from "../src/commands/app.js";
import { dbCommand } from "../src/commands/db.js";
import { failWith, recordCalls, useFakeCoolify } from "./helpers.js";

const TOKEN = "7|supersecrettokenvalue";
const WEBHOOK = "whsec_S3cr3tWebhookValue";
const APP = "app1".padEnd(24, "x");

function fetchOnce(status, body, seen) {
  return async (url, init) => {
    seen.push({ url, init });
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
}

test.beforeEach(() => {
  useFakeCoolify();
  const path = join(mkdtempSync(join(tmpdir(), "coolify-axi-w-")), "config.json");
  writeFileSync(path, JSON.stringify({ instances: [{ name: "hireopz", fqdn: "https://panel.example.com", token: TOKEN, default: true }] }));
  process.env.COOLIFY_AXI_CONFIG = path;
  io.fetchImpl = undefined;
});
test.afterEach(() => {
  delete process.env.COOLIFY_AXI_CONFIG;
  io.fetchImpl = undefined;
});

const text = (value) => JSON.stringify(value);

// ---- app set ----

test("app set PATCHes only the fields given and lists them", async () => {
  const seen = [];
  io.fetchImpl = fetchOnce(200, { uuid: APP }, seen);
  const output = await appCommand([
    "set", "digivaley",
    "--pre-deploy", "pnpm db:migrate", "--pre-deploy-container", "web",
    "--clear-post-deploy", "--health-check", "on", "--health-check-path", "/api/health",
    "--watch-paths", "src/**\napp/**", "--watch-paths", "package.json", "--auto-deploy", "off",
  ]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, "PATCH");
  assert.equal(seen[0].url, `https://panel.example.com/api/v1/applications/${APP}`);
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    pre_deployment_command: "pnpm db:migrate",
    pre_deployment_command_container: "web",
    post_deployment_command: null,
    health_check_enabled: true,
    health_check_path: "/api/health",
    watch_paths: "src/**\napp/**\npackage.json",
    is_auto_deploy_enabled: false,
  });
  assert.equal(output.changed.post_deployment_command, "cleared");
  assert.equal(output.changed.pre_deployment_command, "pnpm db:migrate");
  assert.ok(output.help.length > 0);
});

test("the webhook secret is read from stdin, sent, and never printed", async () => {
  const seen = [];
  // The PATCH response echoes the secret; it must be discarded.
  io.fetchImpl = fetchOnce(200, { uuid: APP, manual_webhook_secret_github: WEBHOOK }, seen);
  io.stdin = async () => `${WEBHOOK}\n`;
  const output = await appCommand(["set", "digivaley", "--webhook-secret-github-stdin"]);
  assert.equal(JSON.parse(seen[0].init.body).manual_webhook_secret_github, WEBHOOK);
  assert.deepEqual(output.changed, { manual_webhook_secret_github: "set" });
  assert.ok(!text(output).includes(WEBHOOK));
});

test("--clear-webhook-secret-github sends null and says cleared", async () => {
  const seen = [];
  io.fetchImpl = fetchOnce(200, { uuid: APP }, seen);
  const output = await appCommand(["set", "digivaley", "--clear-webhook-secret-github"]);
  assert.equal(JSON.parse(seen[0].init.body).manual_webhook_secret_github, null);
  assert.equal(output.changed.manual_webhook_secret_github, "cleared");
});

test("a failed PATCH does not leak the secret from the argument or the error body", async () => {
  io.fetchImpl = fetchOnce(422, { message: `bad secret ${WEBHOOK}`, errors: { manual_webhook_secret_github: ["x"] } }, []);
  await assert.rejects(
    () => appCommand(["set", "digivaley", "--webhook-secret-github", WEBHOOK]),
    (error) => {
      const all = text({ m: error.message, s: error.suggestions });
      assert.ok(!all.includes(WEBHOOK) && !all.includes("supersecrettokenvalue"));
      assert.equal(error.code, "VALIDATION_ERROR");
      return true;
    },
  );
});

for (const [name, argv, pattern] of [
  ["no setting", ["set", "digivaley"], /no setting/],
  ["set and clear", ["set", "digivaley", "--pre-deploy", "x", "--clear-pre-deploy"], /not both/],
  ["bad health path", ["set", "digivaley", "--health-check-path", "/a b"], /health-check-path/],
  ["empty health path", ["set", "digivaley", "--health-check-path", ""], /health-check-path must not be empty/],
  ["bad on/off", ["set", "digivaley", "--auto-deploy", "yes"], /on or off/],
  ["two webhook modes", ["set", "digivaley", "--webhook-secret-github", "x", "--clear-webhook-secret-github"], /not both/],
  ["empty pre-deploy", ["set", "digivaley", "--pre-deploy", ""], /needs a command/],
]) {
  test(`app set rejects ${name} before any request`, async () => {
    const seen = [];
    io.fetchImpl = fetchOnce(200, {}, seen);
    await assert.rejects(() => appCommand(argv), (error) => error.code === "VALIDATION_ERROR" && pattern.test(error.message) && error.suggestions.length > 0);
    assert.equal(seen.length, 0);
  });
}

// ---- app env set / delete ----

test("env set creates and updates runtime-only, and never echoes values", async () => {
  const calls = recordCalls();
  const stripe = "sk_fake_51HabcDEF";
  const pg = "postgres://u:hunter2@db/x";
  const output = await appCommand(["env", "set", "digivaley", `NODE_ENV=staging`, `STRIPE_KEY=${stripe}`, `DATABASE_URL=${pg}`]);
  assert.deepEqual(output.env, [
    { key: "NODE_ENV", updated: true },
    { key: "STRIPE_KEY", created: true },
    { key: "DATABASE_URL", created: true },
  ]);
  for (const secret of [stripe, "hunter2", "staging"]) assert.ok(!text(output).includes(secret));
  const writes = calls().filter((argv) => argv[1] === "env" && argv[2] !== "list");
  assert.deepEqual(writes[0].slice(0, 6), ["app", "env", "update", APP, "NODE_ENV", "--value=staging"]);
  // An update keeps the stored build-time setting; a create is runtime-only.
  assert.ok(!writes[0].some((a) => a.startsWith("--build-time")));
  assert.ok(writes[1].includes("create") && writes[1].includes(`--value=${stripe}`) && writes[1].includes("--build-time=false"));
});

test("legacy env --set keeps upstream build-time defaults and scrubs every error", async () => {
  const calls = recordCalls();
  await appCommand(["env", "digivaley", "--set", "NEW_KEY=abc123value"]);
  const create = calls().find((argv) => argv[2] === "create");
  assert.ok(!create.some((a) => a.startsWith("--build-time")), "legacy --set passes no build flag");
  // The list call fails before any write; its error must still be scrubbed.
  failWith("list broke near abc123value");
  await assert.rejects(
    () => appCommand(["env", "digivaley", "--set", "NEW_KEY=abc123value"]),
    (error) => !text({ m: error.message, s: error.suggestions }).includes("abc123value"),
  );
});

test("a failed child with no stderr never echoes argv flag values", async () => {
  process.env.FAKE_COOLIFY_SILENT_FAIL = "app update";
  try {
    await assert.rejects(
      () => appCommand(["domain", "digivaley", "--add", "https://x.example"]),
      (error) => {
        const all = text({ m: error.message, s: error.suggestions });
        assert.ok(!all.includes("x.example"), all);
        return true;
      },
    );
  } finally {
    delete process.env.FAKE_COOLIFY_SILENT_FAIL;
  }
});

test("secret-shaped child stderr is redacted even with no value to scrub", async () => {
  failWith("connect failed: postgres://u:hunter2@db/x PASSWORD=hunter2");
  await assert.rejects(
    () => appCommand(["get", "digivaley"]),
    (error) => !text({ m: error.message, s: error.suggestions }).includes("hunter2"),
  );
});

test("env set --build makes the variable build-time", async () => {
  const calls = recordCalls();
  const output = await appCommand(["env", "set", "digivaley", "NEXT_PUBLIC_A=1", "--build"]);
  assert.ok(calls().find((argv) => argv[2] === "create").includes("--build-time=true"));
});

test("env set of an unchanged value is a no-op; the same value with --build is a write", async () => {
  const calls = recordCalls();
  const same = await appCommand(["env", "set", "digivaley", "NODE_ENV=production"]);
  assert.deepEqual(same.env, [{ key: "NODE_ENV", unchanged: true }]);
  assert.equal(calls().filter((argv) => argv[2] === "update").length, 0);
  const flip = await appCommand(["env", "set", "digivaley", "NODE_ENV=production", "--build"]);
  assert.equal(flip.env[0].updated, true);
});

test("a failing env write masks the value out of the message and the help argv", async () => {
  failWith("cannot store sk_fake_51HabcDEF");
  await assert.rejects(
    () => appCommand(["env", "set", "digivaley", "STRIPE_KEY=sk_fake_51HabcDEF"]),
    (error) => {
      assert.ok(!text({ m: error.message, s: error.suggestions }).includes("sk_fake_51HabcDEF"));
      return true;
    },
  );
});

test("env set validation: no pairs, no =", async () => {
  await assert.rejects(() => appCommand(["env", "set", "digivaley"]), (e) => e.code === "VALIDATION_ERROR");
  await assert.rejects(() => appCommand(["env", "set", "digivaley", "hunter2"]), (e) => e.code === "VALIDATION_ERROR" && !e.message.includes("hunter2"));
});

test("env delete resolves the key to its uuid and forces the delete", async () => {
  const calls = recordCalls();
  const output = await appCommand(["env", "delete", "digivaley", "NODE_ENV"]);
  assert.deepEqual(output.env, [{ key: "NODE_ENV", deleted: true }]);
  assert.deepEqual(calls().find((argv) => argv[2] === "delete"), ["app", "env", "delete", APP, "envnode", "--force"]);
});

test("env delete of a missing key is NOT_FOUND with near matches and deletes nothing", async () => {
  const calls = recordCalls();
  await assert.rejects(
    () => appCommand(["env", "delete", "digivaley", "NODE_ENV", "NOPE_ENV"]),
    (error) => error.code === "NOT_FOUND",
  );
  await assert.rejects(
    () => appCommand(["env", "delete", "digivaley", "PASSWORD"]),
    (error) => error.code === "NOT_FOUND" && error.suggestions.some((s) => s.includes("DATABASE_PASSWORD")),
  );
  assert.equal(calls().filter((argv) => argv[2] === "delete").length, 0);
});

// ---- creates ----

test("db create postgres resolves names and prints only the allow-list", async () => {
  const calls = recordCalls();
  const output = await dbCommand(["create", "postgres", "blogs-pg", "--server", "localhost", "--project", "blog", "--image", "postgres:18", "--public-port", "5433", "--instant-deploy"]);
  const create = calls().find((argv) => argv[1] === "create").filter((a, i, all) => a !== "--format" && all[i - 1] !== "--format");
  assert.deepEqual(create, [
    "database", "create", "postgresql",
    "--server-uuid", "srv1".padEnd(24, "x"), "--project-uuid", "prj1".padEnd(24, "x"), "--environment-name", "production",
    "--name", "blogs-pg", "--image", "postgres:18", "--is-public", "--public-port", "5433", "--instant-deploy",
  ]);
  assert.ok(!create.some((a) => /pass/i.test(a)), "never pass a generated password");
  assert.deepEqual(output.created, { type: "postgres", name: "blogs-pg", uuid: "newdb".padEnd(24, "x"), status: "created" });
  const out = text(output);
  for (const leak of ["S3cr3tPw", "postgres://", "postgres_password", "internal_db_url"]) assert.ok(!out.includes(leak), leak);
  assert.match(out, /db get blogs-pg/);
});

test("db create redis never prints its password or URL", async () => {
  const output = await dbCommand(["create", "redis", "cache", "--server", "localhost", "--project", "blog", "--environment", "staging"]);
  const out = text(output);
  assert.ok(!out.includes("R3disPw") && !out.includes("redis://"));
  assert.equal(output.created.name, "cache");
});

test("db create validation and lookup misses", async () => {
  const calls = recordCalls();
  await assert.rejects(() => dbCommand(["create", "oracle", "x", "--server", "s", "--project", "p"]), (e) => e.code === "VALIDATION_ERROR");
  await assert.rejects(() => dbCommand(["create", "postgres", "x", "--project", "p"]), (e) => e.code === "VALIDATION_ERROR" && /--server/.test(e.message));
  await assert.rejects(() => dbCommand(["create", "postgres", "x", "--server", "s", "--project", "p", "--public-port", "abc"]), (e) => e.code === "VALIDATION_ERROR");
  assert.equal(calls().length, 0);
  await assert.rejects(() => dbCommand(["create", "postgres", "x", "--server", "nope", "--project", "blog"]), (e) => e.code === "NOT_FOUND");
  // There is no `project list` command here, so the miss names the projects inline.
  await assert.rejects(
    () => dbCommand(["create", "postgres", "x", "--server", "localhost", "--project", "nope"]),
    (e) => e.code === "NOT_FOUND" && e.suggestions.some((s) => s === "1 projects: blog") && !e.suggestions.some((s) => /project list/.test(s)),
  );
});

test("app create from a public URL", async () => {
  const calls = recordCalls();
  const output = await appCommand(["create", "web", "--repo", "https://github.com/acme/web", "--branch", "main", "--server", "localhost", "--project", "blog", "--build-pack", "dockerfile", "--dockerfile-target", "runner", "--port", "3117", "--domain", "https://web.example", "--instant-deploy"]);
  const create = calls().find((argv) => argv[1] === "create").filter((a, i, all) => a !== "--format" && all[i - 1] !== "--format");
  assert.deepEqual(create, [
    "app", "create", "public",
    "--server-uuid", "srv1".padEnd(24, "x"), "--project-uuid", "prj1".padEnd(24, "x"), "--environment-name", "production",
    "--name", "web", "--git-repository", "https://github.com/acme/web", "--git-branch", "main",
    "--build-pack", "dockerfile", "--ports-exposes", "3117", "--domains", "https://web.example",
    "--dockerfile-target-build", "runner", "--instant-deploy",
  ]);
  assert.deepEqual(output.created, { type: "application", name: "web", uuid: "newapp".padEnd(24, "x"), domains: "https://web.example" });
});

test("app create with a GitHub App resolves it by name", async () => {
  const calls = recordCalls();
  await appCommand(["create", "web", "--repo", "acme/web", "--branch", "main", "--server", "localhost", "--project", "blog", "--github-app", "acme-gh"]);
  const create = calls().find((argv) => argv[1] === "create");
  assert.deepEqual(create.slice(0, 5), ["app", "create", "github", "--github-app-uuid", "gh1".padEnd(24, "x")]);
  assert.ok(create.includes("nixpacks") && create.includes("3000"));
});

test("app create validation", async () => {
  const calls = recordCalls();
  const base = ["create", "web", "--branch", "main", "--server", "localhost", "--project", "blog"];
  await assert.rejects(() => appCommand([...base, "--repo", "acme/web"]), (e) => e.code === "VALIDATION_ERROR" && /GitHub App/.test(e.message));
  await assert.rejects(() => appCommand([...base, "--repo", "https://x/y", "--github-app", "g"]), (e) => e.code === "VALIDATION_ERROR");
  await assert.rejects(() => appCommand([...base, "--repo", "https://x/y", "--build-pack", "buildah"]), (e) => e.code === "VALIDATION_ERROR" && e.suggestions[0].includes("nixpacks"));
  await assert.rejects(() => appCommand([...base, "--repo", "https://x/y", "--port", "0"]), (e) => e.code === "VALIDATION_ERROR");
  await assert.rejects(() => appCommand(["create", "web"]), (e) => e.code === "VALIDATION_ERROR" && /--repo/.test(e.message));
  assert.equal(calls().length, 0);
});
