import { existsSync } from "node:fs";
import { join } from "node:path";

/** Match the Agent's read-only pre-BTCC refusal before any desktop launch writes. */
export function unsupportedLegacyData(dataRoot) {
  return existsSync(join(dataRoot, "app-server/butler-client.sqlite")) &&
    !existsSync(join(dataRoot, "agent-runtime/btcc.sqlite"));
}
