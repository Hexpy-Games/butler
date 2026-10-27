import type { MessageRecord } from "@/app/types.ts";
import type { CanonProposalAnchor } from "@/app/canonProposals.ts";
/** Anchors survive pagination; each proposal keeps its originating call identity. */
export function withCanonProposals(messages: MessageRecord[], proposals: readonly CanonProposalAnchor[]): MessageRecord[] {
  if (!proposals.length) return messages;
  const byTurn = new Map<string, CanonProposalAnchor[]>();
  for (const proposal of proposals) byTurn.set(proposal.turn_id, [...byTurn.get(proposal.turn_id) ?? [], proposal]);
  const result = [...messages];
  for (const [turn, anchors] of byTurn) {
    let index = result.length - 1;
    while (index >= 0 && !(result[index].role === "assistant" && result[index].turn_id === turn)) index--;
    if (index >= 0) result[index] = { ...result[index], canon_proposals: anchors };
  }
  return result;
}
