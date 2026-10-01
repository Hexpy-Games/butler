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

/** All timestamps are Unix seconds; status reads never return a code. */
export interface PairingCode {
  id: string;
  code: string;
  expires_at: number;
  expires_in: number;
}
export interface PairingStatus extends Omit<PairingCode, "code"> {
  status: "active" | "expired" | "invalidated" | "paired";
  invalidated_by: string | null;
  device_id: string | null;
}
export interface PairedDevice {
  id: string;
  name: string;
  ip: string;
  created_at: number;
  last_seen_at: number;
}
export const issuePairingCode = () => api<PairingCode>("/security/pairing", { method: "POST" });
export const getPairingStatus = () => api<PairingStatus | null>("/security/pairing");
export const listPairedDevices = () => api<PairedDevice[]>("/security/devices");
export const revokePairedDevice = (deviceId?: string) => api(
  deviceId ? `/security/devices/${encodeURIComponent(deviceId)}` : "/security/devices",
  { method: "DELETE" },
);

/** The gateway answers security calls only to clients on this computer. */
export function isHostOnlyError(error: unknown): boolean {
  return apiErrorCode(error) === "loopback_required";
}

/** On this computer, but main sent no valid admin credential (missing or unreadable file). */
export function isAdminRequiredError(error: unknown): boolean {
  return apiErrorCode(error) === "admin_credential_required";
}
