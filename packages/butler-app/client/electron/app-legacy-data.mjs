import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Match the Agent's read-only pre-BTCC refusal before any desktop launch writes. */
export function unsupportedLegacyData(dataRoot) {
  return existsSync(join(dataRoot, "app-server/butler-client.sqlite")) &&
    !existsSync(join(dataRoot, "agent-runtime/btcc.sqlite"));
}

/**
 * The data folder and the one writable-root rule for App-owned writes into it: `writableRoot` is null while
 * the folder is refused, so a refused folder stays untouched.
 */
export function resolveAppDataRoots(env = process.env, home = homedir()) {
  const dataRoot = env.BUTLER_DATA || join(home, ".butler");
  const legacyDataBlocked = unsupportedLegacyData(dataRoot);
  return { dataRoot, legacyDataBlocked, writableRoot: legacyDataBlocked ? null : dataRoot };
}

let processRoots = null;
/** Resolved once per App process, so every writer (including pre-runtime startup screens) agrees. */
export function appDataRoots() {
  processRoots ??= Object.freeze(resolveAppDataRoots());
  return processRoots;
}
