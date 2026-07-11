export const ROUND_JOURNAL_PROMPT_LIMIT = 18;
export const ROUND_JOURNAL_STABLE_IDENTITY_LIMIT = 24;

export interface DurableTurnRoundJournalEntry {
  sequence: number;
  decision_id?: string;
  semantic_block_id?: string;
  block_title?: string;
  expected_effect?: string;
  repeat_reason?: "polling" | "transient_retry" | "race_confirmation";
  tool: string;
  ok: boolean;
  call_identity: string;
  result_fingerprint: string;
  state_revision: string;
  observed_delta: "mutation" | "evidence" | "none";
  call_coordinates?: Record<string, string | number | boolean>;
  result_preview?: Record<string, unknown>;
}

export interface StableTurnMutationIdentity {
  sequence: number;
  tool: string;
  call_identity: string;
  call_coordinates: Record<string, string | number | boolean>;
}

export function recentTurnRoundJournal(
  entries: readonly DurableTurnRoundJournalEntry[],
): DurableTurnRoundJournalEntry[] {
  return entries.slice(-ROUND_JOURNAL_PROMPT_LIMIT);
}

export function stableTurnMutationIdentities(
  entries: readonly DurableTurnRoundJournalEntry[],
): StableTurnMutationIdentity[] {
  const recentStart = Math.max(0, entries.length - ROUND_JOURNAL_PROMPT_LIMIT);
  return entries.slice(0, recentStart)
    .filter((entry) =>
      entry.ok && entry.observed_delta === "mutation" &&
      entry.call_coordinates && Object.keys(entry.call_coordinates).length > 0)
    .slice(-ROUND_JOURNAL_STABLE_IDENTITY_LIMIT)
    .map((entry) => ({
      sequence: entry.sequence,
      tool: entry.tool,
      call_identity: entry.call_identity,
      call_coordinates: entry.call_coordinates!,
    }));
}
