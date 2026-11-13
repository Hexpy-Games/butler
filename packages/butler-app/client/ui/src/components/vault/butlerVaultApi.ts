import { api } from "@/app/api.ts";
import type { ButlerVaultView } from "@/app/types.ts";

export async function fetchButlerVault(): Promise<ButlerVaultView> {
  return await api<ButlerVaultView>("/setup/butler-vault");
}

export async function enableButlerVault(password?: string): Promise<ButlerVaultView> {
  return await api<ButlerVaultView>("/setup/butler-vault/enable", { method: "POST",
    ...(password === undefined ? {} : { body: JSON.stringify({ password }) }),
  });
}

export async function declineButlerVault(): Promise<ButlerVaultView> {
  return await api<ButlerVaultView>("/setup/butler-vault/decline", { method: "POST" });
}

export async function unlockButlerVault(password: string): Promise<ButlerVaultView> {
  return await api<ButlerVaultView>("/setup/butler-vault/unlock", {
    method: "POST", body: JSON.stringify({ password }),
  });
}

export async function changeButlerVaultPassword(current: string, next: string): Promise<ButlerVaultView> {
  return await api<ButlerVaultView>("/setup/butler-vault/password", {
    method: "POST", body: JSON.stringify({ current, new: next }),
  });
}
