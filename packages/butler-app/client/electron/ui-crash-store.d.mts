import type { UiCrashEntry } from "./ui-crash-log.mjs";
export interface UiCrashStore<Path extends string | null = string> {
  /** Null when there is no accepted data root: nothing is kept. */
  path: Path;
  read(): Promise<UiCrashEntry[]>;
  append(input: unknown): Promise<{ ok: boolean }>;
}
export function createUiCrashStore(dataRoot: string, getVersion: () => string): UiCrashStore;
export function createUiCrashStore(dataRoot: string | null, getVersion: () => string): UiCrashStore<string | null>;
