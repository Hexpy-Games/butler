import { api } from "@/app/api.ts";
import type { ButlerVaultView } from "@/app/types.ts";

export async function fetchButlerVault(): Promise<ButlerVaultView> {
  return await api<ButlerVaultView>("/setup/butler-vault");
}

export async function enableButlerVault(): Promise<ButlerVaultView> {
  return await api<ButlerVaultView>("/setup/butler-vault/enable", { method: "POST" });
}

export async function declineButlerVault(): Promise<ButlerVaultView> {
  return await api<ButlerVaultView>("/setup/butler-vault/decline", { method: "POST" });
}
