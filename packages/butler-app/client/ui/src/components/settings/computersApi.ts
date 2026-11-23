import { api } from "@/app/api.ts";
import type { SignInTransport } from "@/components/first-run/useSignIn";
import type { Computer, ComputerConnection } from "./computerTypes";
import type { MemoryInventory, MemoryReceipt } from "./memoryTypes";
import type { OpenAIOAuthLoginResult } from "./modelManagementApi";

export type { Computer } from "./computerTypes";

export type HostKeyCheck = { trusted: true } | { trusted: false; fingerprint: string; key_type: string };

export interface HostTarget {
  address: string;
  port?: number;
  key_file?: string;
}

export async function listComputers(): Promise<Computer[]> {
  return (await api<{ computers: Computer[] }>("/computers")).computers;
}

export function checkHostKey(target: HostTarget) {
  return api<HostKeyCheck>("/computers/host-key", { method: "POST", body: JSON.stringify(target) });
}

export async function addComputer(input: HostTarget & { name: string; folder: string; host_fingerprint?: string }): Promise<Computer> {
  return (await api<{ computer: Computer }>("/computers", { method: "POST", body: JSON.stringify(input) })).computer;
}

export function startComputer(id: string) {
  return api<{ state: "ready" | "busy"; version: string }>(`/computers/${encodeURIComponent(id)}/start`, { method: "POST" });
}

export function deleteComputer(id: string): Promise<{ deleted: boolean; remote_cleaned: boolean }> {
  return api(`/computers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function computerConnection(id: string): Promise<{ state: ComputerConnection; error: string | null }> {
  return api(`/computers/${encodeURIComponent(id)}/connection`);
}

export function sendComputerCredential(id: string, credentialId: string) {
  return api(`/computers/${encodeURIComponent(id)}/credentials`, {
    method: "POST", body: JSON.stringify({ credential_id: credentialId }),
  });
}

export function computerSignInTransport(id: string): SignInTransport {
  const path = `/computers/${encodeURIComponent(id)}/oauth`;
  return {
    async start(input) {
      const view = await api<OpenAIOAuthLoginResult>(`${path}/start`, {
        method: "POST", body: JSON.stringify({ kind: input.kind ?? "default" }),
      });
      return { backend: "agent", view };
    },
    status: (session) => api(`${path}/${encodeURIComponent(session.view.flow_id!)}`),
    async cancel(session) {
      if (!session.view.flow_id) return undefined;
      return api(`${path}/${encodeURIComponent(session.view.flow_id)}/cancel`, { method: "POST", body: "{}" });
    },
  };
}

export async function forgetComputerMemory(id: string) {
  const inventory = await api<MemoryInventory>("/memory/inventory");
  return api<MemoryReceipt>(`/memory/reset/computers/${encodeURIComponent(id)}`, {
    method: "POST", body: JSON.stringify({ operation_id: crypto.randomUUID(), inventory_revision: inventory.revision }),
  });
}
