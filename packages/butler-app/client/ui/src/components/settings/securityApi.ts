import { api, apiErrorCode } from "@/app/api.ts";
import type { SecurityView } from "@/app/types.ts";

export function getSecurity(): Promise<SecurityView> {
  return api<SecurityView>("/security");
}

/** Rebinds at once, with no restart. */
export async function setRemoteAccess(enabled: boolean): Promise<void> {
  await updateSecurity({ remote_access_enabled: enabled });
}

/** Replaces the whole list. */
export async function setAllowedHosts(hosts: string[]): Promise<void> {
  await updateSecurity({ allowed_hosts: hosts });
}

async function updateSecurity(security: { remote_access_enabled?: boolean; allowed_hosts?: string[] }): Promise<void> {
  await api("/settings", { method: "PATCH", body: JSON.stringify({ security }) });
}

export async function revealConnectionCode(): Promise<string> {
  const { code } = await api<{ code: string }>("/security/connection-code/reveal", { method: "POST" });
  return code;
}

/** Disconnects remote sessions; the desktop bridge re-reads its own token. */
export async function rotateConnectionCode(): Promise<void> {
  await api<{ code: string; created_at: string | null }>("/security/connection-code/rotate", { method: "POST" });
}

/** The gateway answers security calls only to clients on this computer. */
export function isHostOnlyError(error: unknown): boolean {
  return apiErrorCode(error) === "loopback_required";
}
