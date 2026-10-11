import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./fixtures/fake-coolify.mjs", import.meta.url));

/** Point the wrapper at the fake binary instead of a real Coolify install. */
export function useFakeCoolify() {
  process.env.COOLIFY_AXI_BIN = FAKE;
  delete process.env.FAKE_COOLIFY_FAIL;
  delete process.env.FAKE_COOLIFY_LOG;
  delete process.env.FAKE_COOLIFY_STDOUT;
}

const realFetch = globalThis.fetch;

/**
 * Point the REST client at a fake instance. `routes` maps `METHOD /path`
 * (relative to /api/v1) to a JSON body; anything else answers 404. Returns
 * every request seen, with its parsed body.
 */
export function fakeApi(routes) {
  const path = join(mkdtempSync(join(tmpdir(), "coolify-axi-api-")), "config.json");
  writeFileSync(
    path,
    JSON.stringify({ instances: [{ name: "hireopz", fqdn: "https://panel.example.com", token: "7|faketoken", default: true }] }),
  );
  process.env.COOLIFY_AXI_CONFIG = path;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname.replace(/^\/api\/v1/, "")}`;
    seen.push({ key, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const hit = key in routes;
    return { ok: hit, status: hit ? 200 : 404, text: async () => JSON.stringify(hit ? routes[key] : { message: "Not found." }) };
  };
  return seen;
}

export function restoreApi() {
  globalThis.fetch = realFetch;
  delete process.env.COOLIFY_AXI_CONFIG;
}

/**
 * Record every argv the wrapper sends to the fake binary, so a test can assert
 * that a no-op really did not shell out.
 */
export function recordCalls() {
  const path = join(tmpdir(), `coolify-axi-calls-${Math.random().toString(36).slice(2)}`);
  process.env.FAKE_COOLIFY_LOG = path;
  return () => {
    let raw = "";
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
}

export function failWith(message) {
  process.env.FAKE_COOLIFY_FAIL = message;
}
