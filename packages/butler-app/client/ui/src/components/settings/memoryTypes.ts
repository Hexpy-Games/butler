import type { SettingsSectionState } from "@/butler-ds";
export interface Instruction {
  handle: string; text: string; revision: string; project_id: string | null;
  scope: { kind: "all" | "project"; project_name?: string | null };
}
export interface MemoryCard {
  kind: string; item_count: number | null; pending_count: number | null;
  allocated_bytes: number | null; content_updated_at: string | null;
  health: { consent_on?: boolean; reclaimable_bytes?: number | null; state?: string };
}
export interface MemoryReceipt {
  operation_id: string; phase: "preparing" | "removing" | "complete" | "failed" | "cancelled";
  sequence: number; bytes_reclaimed: number;
}
export interface MemoryInventory { revision: number; kinds: MemoryCard[]; operation?: MemoryReceipt }
export interface ProjectMemory {
  project_id: string; summary_bytes?: number | null; conversations?: number;
  instructions?: number; updated_at?: string | null;
}
export interface MemoryProject { ledger_project_id?: string; id: string; display_name: string }
export function cardState(state: SettingsSectionState, card?: MemoryCard): SettingsSectionState {
  return state !== "ready" ? state : card && card.health.state !== "unavailable" ? "ready" : "empty";
}
