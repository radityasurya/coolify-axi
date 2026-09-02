import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./fixtures/fake-coolify.mjs", import.meta.url));

/** Point the wrapper at the fake binary instead of a real Coolify install. */
export function useFakeCoolify() {
  process.env.COOLIFY_AXI_BIN = FAKE;
  delete process.env.FAKE_COOLIFY_FAIL;
}

export function failWith(message) {
  process.env.FAKE_COOLIFY_FAIL = message;
}
