import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "../src/api.js";

const TOKEN = "7|supersecrettokenvalue";

function config() {
  const dir = mkdtempSync(join(tmpdir(), "coolify-axi-api-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      instances: [
        { name: "cloud", fqdn: "https://app.coolify.io", token: "other" },
        { name: "hireopz", fqdn: "https://panel.example.com/", token: TOKEN, default: true },
      ],
    }),
  );
  return { COOLIFY_AXI_CONFIG: path };
}

function fakeFetch(status, body, seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    return {
      ok: status < 400,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
}

test("api sends the default instance's bearer token and returns parsed JSON", async () => {
  const seen = [];
  const out = await api("PATCH", "/applications/abc", { name: "x" }, {
    env: config(),
    fetchImpl: fakeFetch(200, { uuid: "abc" }, seen),
  });
  assert.deepEqual(out, { uuid: "abc" });
  assert.equal(seen[0].url, "https://panel.example.com/api/v1/applications/abc");
  assert.equal(seen[0].init.method, "PATCH");
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].init.body, JSON.stringify({ name: "x" }));
});

test("api picks an instance by --context name", async () => {
  const seen = [];
  await api("GET", "/version", undefined, { context: "cloud", env: config(), fetchImpl: fakeFetch(200, "4.0", seen) });
  assert.match(seen[0].url, /^https:\/\/app\.coolify\.io\/api\/v1\/version$/);
  assert.equal(seen[0].init.body, undefined);
});

test("an unknown context is a validation error listing the configured ones", async () => {
  await assert.rejects(
    () => api("GET", "/version", undefined, { context: "nope", env: config(), fetchImpl: fakeFetch(200, {}) }),
    (error) => error.code === "VALIDATION_ERROR" && error.suggestions.join(" ").includes("hireopz"),
  );
});

for (const [status, code] of [[401, "AUTH_ERROR"], [404, "NOT_FOUND"], [409, "CONFLICT"], [422, "VALIDATION_ERROR"], [500, "COOLIFY_ERROR"]]) {
  test(`HTTP ${status} maps to ${code} without leaking the token or the raw body`, async () => {
    const body = {
      message: `failed for ${TOKEN} with postgres://u:hunter2@db/x`,
      errors: { pre_deployment_command: ["bad"] },
      trace: "RAWBODYSTACK",
    };
    await assert.rejects(
      () => api("GET", "/applications/x", undefined, { env: config(), fetchImpl: fakeFetch(status, body) }),
      (error) => {
        const everything = JSON.stringify({ message: error.message, help: error.suggestions });
        assert.equal(error.code, code);
        assert.ok(!everything.includes("supersecrettokenvalue"), "token leaked");
        assert.ok(!everything.includes("hunter2"), "password leaked");
        assert.ok(!everything.includes("RAWBODYSTACK"), "raw body leaked");
        assert.ok(error.suggestions.length > 0, "every error names a next step");
        if (status === 422) assert.match(everything, /pre_deployment_command/);
        return true;
      },
    );
  });
}

test("a network failure names the host, never the token", async () => {
  const fetchImpl = async () => {
    throw new TypeError(`fetch failed ${TOKEN}`);
  };
  await assert.rejects(
    () => api("GET", "/version", undefined, { env: config(), fetchImpl }),
    (error) => error.code === "COOLIFY_ERROR" && /panel\.example\.com/.test(error.message) && !error.message.includes(TOKEN),
  );
});

test("a missing config file points at the CLI's context setup", async () => {
  await assert.rejects(
    () => api("GET", "/version", undefined, { env: { COOLIFY_AXI_CONFIG: "/nonexistent/config.json" }, fetchImpl: fakeFetch(200, {}) }),
    (error) => error.code === "VALIDATION_ERROR",
  );
});
