export interface UiCrashEntry {
  message: string;
  stack: string;
  componentStack: string;
  page: string;
  scope: string;
  appVersion: string;
  timestamp: string;
}
export const CRASH_LOG_LIMIT: number;
export const CRASH_LOG_BYTES: number;
export const CRASH_LOG_KEY: string;
export function normalizeCrash(input: unknown, version?: string): UiCrashEntry;
export function appendCrash(entries: UiCrashEntry[], input: unknown, version?: string): UiCrashEntry[];
