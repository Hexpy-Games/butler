import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillName = "butler-design-system";
const currentFile = fileURLToPath(import.meta.url);
const designSystemRoot = resolve(dirname(currentFile), "..");
const source = join(designSystemRoot, "skills", skillName);
const targetRoot = process.env.CODEX_HOME
  ? join(process.env.CODEX_HOME, "skills")
  : join(homedir(), ".codex", "skills");
const target = join(targetRoot, skillName);

if (!existsSync(source)) {
  throw new Error(`Design system skill source is missing: ${source}`);
}

mkdirSync(targetRoot, { recursive: true });
rmSync(target, { force: true, recursive: true });
cpSync(source, target, { recursive: true });

console.log(`Installed ${skillName} skill to ${target}`);
