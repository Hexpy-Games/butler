import { api } from "./api.ts";

export const BUTLER_PLANS_URL: string | undefined = undefined;

export interface ButlerBackupStatus {
  available: boolean;
  state: "off" | "idle" | "running" | "failed" | "paused" | "full" | "restore_available" | "restoring" | "restore_ready";
  last_backup_at: string | null;
  used_bytes: number;
  quota_bytes: number;
  progress: { done: number; total: number };
  error: string | null;
  restore: { created_at: string; total_bytes: number } | null;
  memory_search_preparing: boolean;
}

type KeyAction = "create_key" | "new_key";
type BackupAction = "start" | "cancel" | "back_up_now" | "turn_off" | "restart";

export function getButlerBackup() {
  return api<ButlerBackupStatus>("/setup/butler-backup");
}

export function sendButlerBackup(action: KeyAction): Promise<{ recovery_key: string }>;
export function sendButlerBackup(action: BackupAction): Promise<unknown>;
export function sendButlerBackup(action: "restore", extra: { recovery_key: string }): Promise<unknown>;
export function sendButlerBackup(action: KeyAction | BackupAction | "restore", extra?: { recovery_key: string }) {
  return api("/setup/butler-backup", { method: "POST", body: JSON.stringify({ action, ...extra }) });
}
