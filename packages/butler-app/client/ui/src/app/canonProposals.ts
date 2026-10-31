import { api } from "./api.ts";
import type { CanonProposal } from "../../../shared/canon-proposal-contracts.ts";
import type { TimelineEvent } from "./types.ts";
export type { CanonProposal, CanonProposalAnchor } from "../../../shared/canon-proposal-contracts.ts";
const listeners = new Map<string, Set<() => void>>();
const path = (id: string) => `/canon/proposals/${encodeURIComponent(id)}`;
export const getCanonProposal = (id: string, signal?: AbortSignal) => api<CanonProposal>(path(id), { signal });
export const resolveCanonProposal = (id: string, outcome: "accepted" | "declined", target?: { project_id?: string; new_name?: string }) =>
  api<{ ok: boolean; error?: { code: string } }>(path(id), { method: "POST", body: JSON.stringify({ outcome, ...target }) });
export function observeCanonProposal(id: string, listener: () => void) {
  let set = listeners.get(id);
  if (!set) { set = new Set(); listeners.set(id, set); }
  set.add(listener);
  return () => { set.delete(listener); if (!set.size) listeners.delete(id); };
}
export function publishCanonProposalEvent(event: TimelineEvent) {
  if (event.type === "stream.reconcile_required") for (const set of listeners.values()) for (const listener of set) listener();
  const id = (event.payload as Record<string, unknown> | undefined)?.proposal_id;
  if (event.type === "pending_asks.changed" && typeof id === "string") {
    for (const listener of listeners.get(id) ?? []) listener();
  }
}
