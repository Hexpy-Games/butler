import { api } from "./api.ts";

export type ButlerAccountStatus = { signed_in: false } | {
  signed_in: true;
  account: { id: string; email: string; created_at: string };
  device: { id: string; name: string; platform: string };
  entitlements: { plan: string; status: string; renews_at: string | null; features: Record<string, unknown> };
};

export interface ButlerAccountDevice {
  id: string;
  name: string;
  platform: string;
  created_at: string;
  last_seen_at: string | null;
  current: boolean;
}

export function getButlerAccount() {
  return api<ButlerAccountStatus>("/setup/butler-account");
}

export function startButlerAccount(email: string) {
  return api<{ sent: true }>("/setup/butler-account", { method: "POST", body: JSON.stringify({ action: "start", email }) });
}

export function verifyButlerAccount(email: string, code: string) {
  return api<ButlerAccountStatus>("/setup/butler-account", { method: "POST", body: JSON.stringify({ action: "verify", email, code }) });
}

export function signOutButlerAccount() {
  return api<{ signed_in: false }>("/setup/butler-account", { method: "DELETE" });
}

export function listButlerAccountDevices() {
  return api<{ devices: ButlerAccountDevice[] }>("/setup/butler-account/devices");
}

export function revokeButlerAccountDevice(id: string) {
  return api<{ revoked: true }>(`/setup/butler-account/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
}
