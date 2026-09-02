#!/usr/bin/env node
// Writes skills/<name>/SKILL.md from src/skill.js, or verifies it is current.
// CI runs `--check` so a hand-edit or a stale commit fails the build.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_NAME, renderSkill } from "../src/skill.js";

const target = fileURLToPath(new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url));
const next = renderSkill();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    console.error(`missing ${target} — run \`npm run build:skill\``);
    process.exit(1);
  }
  if (current !== next) {
    console.error(`${target} is stale — run \`npm run build:skill\` and commit the result`);
    process.exit(1);
  }
  console.log(`${SKILL_NAME} skill is up to date`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next);
  console.log(`wrote ${target}`);
}
