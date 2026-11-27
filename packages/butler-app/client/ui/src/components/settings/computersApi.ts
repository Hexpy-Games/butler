import { api } from "@/app/api.ts";
import type { SignInTransport } from "@/components/first-run/useSignIn";
import type { Computer, ComputerConnection, ComputerModelSource } from "./computerTypes";
import type { MemoryInventory, MemoryReceipt } from "./memoryTypes";
import type { OpenAIOAuthLoginResult } from "./modelManagementApi";

export { listComputers } from "@/app/computerEvents.ts";
export type { Computer } from "./computerTypes";

export type HostKeyCheck = { trusted: true };

export interface HostTarget {
  address: string;
  port?: number;
  key_file?: string;
}

interface ComputerInput extends HostTarget {
  name: string;
  folder: string;
  model_source: ComputerModelSource;
  managed_key?: boolean;
  password?: string;
  environment?: Array<{ name: string; value?: string }>;
  environment_text?: string;
}

export function checkHostKey(target: HostTarget) {
  return api<HostKeyCheck>("/computers/host-key", { method: "POST", body: JSON.stringify(target) });
}

export function stashComputerPassword(input: { request_ref: string; password: string }) {
  return api<{ stored: true }>("/computers/password", { method: "POST", body: JSON.stringify(input) });
}

export async function addComputer(input: ComputerInput): Promise<Computer> {
  return (await api<{ computer: Computer }>("/computers", { method: "POST", body: JSON.stringify(input) })).computer;
}

export async function editComputer(id: string, input: ComputerInput): Promise<Computer> {
  return (await api<{ computer: Computer }>(`/computers/${encodeURIComponent(id)}`, {
    method: "PUT", body: JSON.stringify(input),
  })).computer;
}

export function startComputer(id: string) {
  return api<{ state: "ready" | "busy"; version: string }>(`/computers/${encodeURIComponent(id)}/start`, { method: "POST" });
}

export function deleteComputer(id: string, force = false): Promise<{ deleted: boolean; remote_cleaned: boolean; key_removed?: boolean }> {
  return api(`/computers/${encodeURIComponent(id)}${force ? "?force=true" : ""}`, { method: "DELETE" });
}

export function reconnectComputer(id: string): Promise<{ state: ComputerConnection; error: string | null }> {
  return api(`/computers/${encodeURIComponent(id)}/reconnect`, { method: "POST" });
}

export function computerConnection(id: string): Promise<{ state: ComputerConnection; error: string | null }> {
  return api(`/computers/${encodeURIComponent(id)}/connection`);
}

export async function updateComputerModel(id: string, model_source: ComputerModelSource): Promise<Computer> {
  return (await api<{ computer: Computer }>(`/computers/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify({ model_source }),
  })).computer;
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
