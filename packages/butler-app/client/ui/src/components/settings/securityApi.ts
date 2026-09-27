import { api } from "@/app/api.ts";
import type { SecurityView } from "@/app/types.ts";

export function getSecurity(): Promise<SecurityView> {
  return api<SecurityView>("/security");
}

export async function setRemoteAccess(enabled: boolean): Promise<void> {
  await api("/settings", {
    method: "PATCH",
    body: JSON.stringify({ security: { remote_access_enabled: enabled } }),
  });
}

export async function revealConnectionCode(): Promise<string> {
  const { code } = await api<{ code: string }>("/security/connection-code/reveal", { method: "POST" });
  return code;
}

/** Disconnects remote sessions; the desktop bridge re-reads its own token. */
export async function rotateConnectionCode(): Promise<void> {
  await api<{ code: string; created_at: string }>("/security/connection-code/rotate", { method: "POST" });
}

/** The gateway allows security reads and changes from loopback clients only. */
export function isHostOnlyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 403;
}
