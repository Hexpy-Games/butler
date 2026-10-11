import { api } from "@/app/api.ts";

export interface VaultUse { result: string; origin: string; at: string }
export interface VaultCard {
  id: string; nickname: string; brand: string; last4: string; exp_month: number; exp_year: number;
  holder_name: string; extras: string[]; sites: string[]; uses: VaultUse[]; last_used_at: string | null;
}
export interface VaultProfile {
  id: string; nickname: string; details: Record<string, string>; extras: string[]; sites: string[]; uses: VaultUse[]; last_used_at: string | null;
}
export interface VaultView {
  available: boolean; reveal_available: boolean; cards: VaultCard[]; profiles: VaultProfile[]; purchase_sites: string[];
}
export type VaultKind = "cards" | "profiles";

/** Card numbers and identity numbers go to the Agent's keychain store through main; only a reveal answers a number. */
export const listVault = () => api<VaultView>("/security/vault");
export const addVaultItem = (kind: VaultKind, input: Record<string, unknown>) =>
  api<{ id: string }>(`/security/vault/${kind}`, { method: "POST", body: JSON.stringify(input) });
export const updateVaultItem = (kind: VaultKind, id: string, input: Record<string, unknown>) =>
  api(`/security/vault/${kind}/${id}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteVaultItem = (kind: VaultKind, id: string) => api(`/security/vault/${kind}/${id}`, { method: "DELETE" });
export const setVaultSite = (kind: VaultKind, id: string, site: string, allow: boolean) =>
  api(`/security/vault/${kind}/${id}/sites`, { method: "POST", body: JSON.stringify({ site, allow }) });
export const setPurchaseSite = (site: string, allow: boolean) =>
  api("/security/vault/purchase-sites", { method: "POST", body: JSON.stringify({ site, allow }) });
/** The operating system asks the user (Touch ID, Windows Hello or password) before the number comes back. */
export const revealCard = (id: string, locale: string) =>
  api<{ number: string }>(`/security/vault/cards/${id}/reveal`, { method: "POST", body: JSON.stringify({ locale }) });

export const revealProfile = (id: string, locale: string) =>
  api<{ number: string }>(`/security/vault/profiles/${id}/reveal`, { method: "POST", body: JSON.stringify({ locale }) });
