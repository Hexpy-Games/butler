import type { Database } from "bun:sqlite";
import {
  R2_ONLY_NONTERMINAL_TURN_STATES,
  R3_PRESERVED_TURN_STATES,
  type LegacyTurnCutoverDiagnostic,
} from "./contracts.ts";

export type LegacyTurnRow = {
  turn_id: string;
  session_id: string;
  original_message_id: string;
  original_message: string;
  semantic_state: string;
  revision: number;
  execution_fence: number;
  active_checkpoint_id: string | null;
  route: string | null;
  opening_answer_json: string | null;
  managed_state_json: string | null;
  final_payload_json: string | null;
  goal_contract_ref: string | null;
  final_dossier_ref: string | null;
  delivery_outbox_id: string | null;
  canonical_assistant_message_id: string | null;
  final_disposition: string | null;
};

const R2_STATES = new Set<string>(R2_ONLY_NONTERMINAL_TURN_STATES);
const R3_STATES = new Set<string>(R3_PRESERVED_TURN_STATES);

export function isR2OnlyNonterminalState(state: string): boolean {
  return R2_STATES.has(state);
}

export function isR3PreservedState(state: string): boolean {
  return R3_STATES.has(state);
}

export function loadTurns(db: Database): LegacyTurnRow[] {
  const columns = new Set(db.query<{ name: string }, []>(
    "PRAGMA table_info(btcc_turns)",
  ).all().map((column) => column.name));
  const optional = (name: string) => columns.has(name) ? name : `NULL AS ${name}`;
  return db.query<LegacyTurnRow, []>(`
    SELECT turn_id, session_id, original_message_id, original_message,
      semantic_state, revision, execution_fence,
      active_checkpoint_id, route, ${optional("opening_answer_json")},
      ${optional("managed_state_json")}, final_payload_json,
      ${optional("goal_contract_ref")}, ${optional("final_dossier_ref")},
      delivery_outbox_id, canonical_assistant_message_id, final_disposition
    FROM btcc_turns ORDER BY turn_id
  `).all();
}

export function loadEvidenceTurnIds(db: Database): Set<string> {
  const rows = db.query<{ turn_id: string }, []>(`
    SELECT turn_id FROM btcc_r3_legacy_turn_cutovers ORDER BY turn_id
  `).all();
  return new Set(rows.map((row) => row.turn_id));
}

export function preflightDiagnostics(
  db: Database,
  turns: LegacyTurnRow[],
  evidenceTurnIds: Set<string>,
): LegacyTurnCutoverDiagnostic[] {
  const diagnostics: LegacyTurnCutoverDiagnostic[] = [];
  const turnIds = new Set(turns.map((turn) => turn.turn_id));
  for (const turnId of evidenceTurnIds) {
    if (!turnIds.has(turnId)) {
      diagnostics.push({
        turnId,
        code: "cutover_evidence_turn_missing",
        detail: "Cutover evidence exists without its authoritative Turn.",
      });
    }
  }
  for (const turn of turns) {
    if (
      !isR2OnlyNonterminalState(turn.semantic_state) &&
      !isR3PreservedState(turn.semantic_state)
    ) {
      diagnostics.push({
        turnId: turn.turn_id,
        code: "unknown_semantic_state",
        semanticState: turn.semantic_state,
        detail: "The Turn state is not a known R2 cutover or R3 preserved state.",
      });
      continue;
    }
    if (
      evidenceTurnIds.has(turn.turn_id) &&
      isR2OnlyNonterminalState(turn.semantic_state)
    ) {
      diagnostics.push({
        turnId: turn.turn_id,
        code: "cutover_evidence_state_reverted",
        semanticState: turn.semantic_state,
        detail: "A previously cut over Turn reverted to an R2-only state.",
      });
      continue;
    }
    if (evidenceTurnIds.has(turn.turn_id) && turn.semantic_state === "admitted") {
      diagnostics.push({
        turnId: turn.turn_id,
        code: "unsafe_legacy_reentry_evidence",
        semanticState: turn.semantic_state,
        detail:
          "An earlier cutover admitted this legacy Turn for model re-entry; it is quarantined to prevent duplicate effects.",
      });
      continue;
    }
    if (
      isR2OnlyNonterminalState(turn.semantic_state) &&
      hasDeliveryAuthority(db, turn)
    ) {
      diagnostics.push({
        turnId: turn.turn_id,
        code: "legacy_delivery_state_conflict",
        semanticState: turn.semantic_state,
        detail:
          "An R2-only Turn already owns delivery authority and requires isolated recovery.",
      });
    }
  }
  return diagnostics.sort((left, right) =>
    left.turnId.localeCompare(right.turnId) ||
    left.code.localeCompare(right.code));
}

function hasDeliveryAuthority(db: Database, turn: LegacyTurnRow): boolean {
  if (turn.delivery_outbox_id || turn.canonical_assistant_message_id) return true;
  return Boolean(db.query<{ present: number }, [string]>(`
    SELECT 1 AS present FROM btcc_delivery_outbox WHERE turn_id = ? LIMIT 1
  `).get(turn.turn_id));
}
