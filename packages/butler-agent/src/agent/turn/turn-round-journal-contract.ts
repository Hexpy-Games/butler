export const ROUND_JOURNAL_PROMPT_LIMIT = 18;

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
  result_preview?: Record<string, unknown>;
}

export function recentTurnRoundJournal(
  entries: readonly DurableTurnRoundJournalEntry[],
): DurableTurnRoundJournalEntry[] {
  return entries.slice(-ROUND_JOURNAL_PROMPT_LIMIT);
}
