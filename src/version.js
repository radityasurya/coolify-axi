// Leaf module: node builtins only, so `--version` never loads the command graph.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version;
