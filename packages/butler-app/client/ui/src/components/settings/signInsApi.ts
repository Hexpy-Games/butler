import { api } from "@/app/api.ts";

export type SignInPolicy = "always" | "ask" | "never";
export interface SignInEntry {
  id: string;
  username: string;
  policy: SignInPolicy;
  last_used_at: string | null;
}
export interface SignInSiteRow {
  site: string;
  entry: SignInEntry | null;
  conversations: number;
  all_conversations: boolean;
  uses: Array<{ result: string; at: string }>;
}
export interface SignInsView { available: boolean; sites: SignInSiteRow[] }

export const listSignIns = () => api<SignInsView>("/security/signins");
/** The password goes to the Agent's keychain store through main; it is never read back. */
export const addSignIn = (input: { site: string; username: string; password: string }) =>
  api("/security/signins", { method: "POST", body: JSON.stringify(input) });
export const setSignInPolicy = (id: string, policy: SignInPolicy) =>
  api(`/security/signins/${id}`, { method: "PATCH", body: JSON.stringify({ policy }) });
export const deleteSignIn = (id: string) => api(`/security/signins/${id}`, { method: "DELETE" });
export const setAllConversations = (site: string, value: boolean) =>
  api("/security/signins/site", { method: "POST", body: JSON.stringify({ site, all_conversations: value }) });
export const revokeSite = (site: string) =>
  api("/security/signins/site", { method: "POST", body: JSON.stringify({ site, revoke: true }) });

export interface ImportSource { key: string; browser: string; name: string; permission?: "ready" | "denied"; passwords?: "direct" | "csv" }
export type ImportRequest = { kind: "bookmarks"; source?: string; path?: string } | { kind: "passwords"; path: string };
export const listImportSources = () => api<{ sources: ImportSource[] }>("/security/browser-import/sources");
export const previewImport = (input: ImportRequest) =>
  api<Record<string, number>>("/security/browser-import/preview", { method: "POST", body: JSON.stringify(input) });
export const runImport = (input: ImportRequest) =>
  api<Record<string, number>>("/security/browser-import/run", { method: "POST", body: JSON.stringify(input) });

interface DesktopBridge {
  pickImportFile?: (kind: "bookmarks" | "passwords") => Promise<{ path: string; name: string } | null>;
}
interface BrowserBridge { call?: (op: string, input?: unknown) => Promise<unknown> }

/** The export file is chosen in a native dialog; its contents never reach this page. */
export async function pickImportFile(kind: "bookmarks" | "passwords") {
  const bridge = (globalThis as { butlerApp?: DesktopBridge }).butlerApp;
  return await bridge?.pickImportFile?.(kind) ?? null;
}

/** "이 사이트 로그아웃" clears the site from the App's signed-in browser profile (desktop only). */
export function canSignOut(): boolean {
  return typeof (globalThis as { butlerBrowser?: BrowserBridge }).butlerBrowser?.call === "function";
}
export async function signOutSite(site: string) {
  await (globalThis as { butlerBrowser?: BrowserBridge }).butlerBrowser?.call?.("signout", { site });
}

export interface BrowserImportCounts { run_id: string; bookmarks: number; history?: number; passwords: number; updated: number; existing: number; needs_csv?: boolean; export_id?: string; waiting?: boolean; error?: string }
export interface BrowserImportInput { source: string; bookmarks: boolean; history?: boolean; passwords: boolean; primary_password?: string; bookmarks_path?: string; passwords_path?: string }
const importAction = <T>(op: string, body: unknown) => api<T>(`/security/browser-import/${op}`, { method: "POST", body: JSON.stringify(body) });
export const startBrowserImport = (input: BrowserImportInput) => importAction<BrowserImportCounts>("start", input);
export const undoBrowserImport = (run_id: string) => importAction("undo", { run_id });
export const pickBrowserFolder = (source: string) => importAction<{ selected: boolean; source?: string }>("folder", { source });
export const openImportDiskAccess = () => importAction("disk-access", {});
export const beginPasswordExport = (source: string, run_id: string) => importAction<{ export_id: string }>("export", { source, run_id });
export const pollPasswordExport = (export_id: string) => importAction<BrowserImportCounts>("export/poll", { export_id });
export const deletePasswordExport = (export_id: string) => importAction("export/delete", { export_id });
export const cancelPasswordExport = (export_id: string) => importAction("export/cancel", { export_id });

export const choosePasswordExport = (export_id: string, path: string) => importAction<BrowserImportCounts>("export/file", { export_id, path });
