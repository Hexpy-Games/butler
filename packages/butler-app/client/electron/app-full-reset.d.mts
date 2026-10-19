import type { SecurityBridgeResult } from "./app-security-admin.mjs";

export const FULL_RESET_CONFIRMATION: string;
export const FULL_RESET_USER_DATA_PATHS: readonly string[];
export const FULL_RESET_PENDING_FILE: string;

export function requestFullReset(
  input: unknown,
  options: {
    ensureReady: () => Promise<unknown>;
    fetch: (url: URL, init: RequestInit) => Promise<Response>;
    serverUrl: string;
    authHeaders: () => Promise<Record<string, string>> | Record<string, string>;
    adminCredential: string | null;
  },
): Promise<{ ok: true } | Extract<SecurityBridgeResult, { ok: false }>>;

export function clearAppOwnedData(options: {
  userDataPath: string;
  clearSessions: () => Promise<unknown>;
}): Promise<void>;

export function relaunchAfterFullReset(options: {
  userDataPath: string;
  previousGeneration: string | null;
  stopAgent: () => Promise<unknown>;
  quiesceRenderer: () => Promise<unknown>;
  clearSessions: () => Promise<unknown>;
  relaunch: () => void;
  log?: (line: string) => void;
}): Promise<void>;
