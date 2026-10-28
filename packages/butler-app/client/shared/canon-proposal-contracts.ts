import type { MessageFileRef } from "../ui/src/app/types.ts";
import type { CanonTagColor } from "./canon-contracts.ts";
export interface CanonProposalAnchor { proposal_id: string; turn_id: string; source_call_id: string }
export interface CanonProposal {
  proposal_id: string; session_id: string; state: "open" | "applied" | "cancelled" | "superseded" | "stale";
  summary: string; target_label: string;
  project: { id: string | null; name: string } | { new_name: string };
  plan: { id: string; title: string } | null;
  changes: Array<{ op: string; id?: string; title?: string; description?: string; body?: string; due_on?: string | null; status?: string; assignee?: string | null; order_titles?: string[]; current_plan_title?: string | null; destination_plan_title?: string | null }>;
  epics: Array<{ title: string; description: string; tags: Array<{ id?: string; name: string; color: CanonTagColor; new?: boolean }>; attachments: MessageFileRef[] }>;
  created_at: string; resolved_at?: string; resolved_by?: "card" | "chat" | null;
}
