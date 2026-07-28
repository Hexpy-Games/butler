import { closeSync, fsyncSync, openSync } from "node:fs";
import type { DurableSyncAdapter } from "../contracts.ts";

export const windowsDurableSync: DurableSyncAdapter = {
  syncFile(path) {
    const descriptor = openSync(path, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  },
  syncDirectory() {
    // Windows does not expose directory handles through node:fs openSync.
  },
};
