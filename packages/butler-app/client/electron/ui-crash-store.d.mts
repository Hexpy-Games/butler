import type { UiCrashEntry } from "./ui-crash-log.mjs";
export function createUiCrashStore(dataRoot: string, getVersion: () => string): {
  path: string;
  read(): Promise<UiCrashEntry[]>;
  append(input: unknown): Promise<{ ok: boolean }>;
};
