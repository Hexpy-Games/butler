import { closeSync, fsyncSync, openSync } from "node:fs";
import type { DurableSyncAdapter } from "../contracts.ts";

export const posixDurableSync: DurableSyncAdapter = {
  syncFile(path) {
    syncDescriptor(openSync(path, "r"));
  },
  syncDirectory(path) {
    syncDescriptor(openSync(path, "r"));
  },
};

function syncDescriptor(descriptor: number): void {
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
