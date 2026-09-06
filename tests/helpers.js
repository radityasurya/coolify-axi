import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./fixtures/fake-coolify.mjs", import.meta.url));

/** Point the wrapper at the fake binary instead of a real Coolify install. */
export function useFakeCoolify() {
  process.env.COOLIFY_AXI_BIN = FAKE;
  delete process.env.FAKE_COOLIFY_FAIL;
  delete process.env.FAKE_COOLIFY_LOG;
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
