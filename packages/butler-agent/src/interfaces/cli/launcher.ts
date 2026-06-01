import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function defaultButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function resolveButlerRuntime(data: string): string {
  if (process.env.BUTLER_BUN) return process.env.BUTLER_BUN;
  const managed = join(data, "runtime", "bun", "current", "bin", "bun");
  return existsSync(managed) ? managed : "bun";
}

const butlerData = defaultButlerData();
const butlerHome = process.env.BUTLER_HOME || join(homedir(), "butler");
const butlerBun = resolveButlerRuntime(butlerData);
const entrypoint = join(butlerHome, "bin", "butler.js");

const result = spawnSync(butlerBun, ["run", entrypoint, ...process.argv.slice(2)], {
  cwd: butlerHome,
  stdio: "inherit",
  env: {
    ...process.env,
    BUTLER_HOME: butlerHome,
    BUTLER_DATA: butlerData,
    BUTLER_BUN: butlerBun,
  },
});

if (result.error) {
  console.error(`Could not launch Butler CLI with ${butlerBun}: ${result.error.message}`);
}

process.exit(result.status ?? 1);
