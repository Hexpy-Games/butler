import type { Database } from "bun:sqlite";
import { digest, stableJson } from "../identity.ts";
import type {
  LegacyTurnCutoverDiagnostic,
  LegacyTurnCutoverResult,
} from "./contracts.ts";
import {
  convertLegacyTurn,
  CutoverCasConflict,
} from "./convert-legacy-turn.ts";
import {
  isR2OnlyNonterminalState,
  isR3PreservedState,
  loadEvidenceTurnIds,
  loadTurns,
  preflightDiagnostics,
} from "./legacy-turn-preflight.ts";
import { pendingCutoverBlockers } from "./pending-effect-blockers.ts";
import { publicCutoverBlockers } from "./preserve-effect-blockers.ts";
import { settleQuarantinedTurn } from "./settle-quarantined-turn.ts";

export function cutoverLegacyBtccTurns(
  db: Database,
  options: { now?: Date } = {},
): LegacyTurnCutoverResult {
  const cutoverAt = canonicalTimestamp(options.now);
  try {
    return db.transaction(() => cutoverInTransaction(db, cutoverAt))();
  } catch (error) {
    if (!(error instanceof CutoverCasConflict)) throw error;
    return db.transaction(() => quarantineAfterConflict(db, error, cutoverAt))();
  }
}

function cutoverInTransaction(
  db: Database,
  cutoverAt: string,
): LegacyTurnCutoverResult {
  const turns = loadTurns(db);
  const evidenceTurnIds = loadEvidenceTurnIds(db);
  const diagnostics = preflightDiagnostics(db, turns, evidenceTurnIds);
  recordQuarantines(db, diagnostics, cutoverAt);
  settleDiagnosedTurns(db, turns, diagnostics);
  const quarantinedTurnIds = unique(diagnostics.map((item) => item.turnId));
  const quarantined = new Set(quarantinedTurnIds);
  const legacyTurns = turns.filter((turn) =>
    isR2OnlyNonterminalState(turn.semantic_state) &&
    !evidenceTurnIds.has(turn.turn_id) &&
    !quarantined.has(turn.turn_id));
  const blockers = legacyTurns.flatMap((turn) =>
    pendingCutoverBlockers(db, turn.turn_id, turn.active_checkpoint_id));
  const blockersByTurn = new Map<string, typeof blockers>();
  for (const blocker of blockers) {
    const current = blockersByTurn.get(blocker.turnId) ?? [];
    current.push(blocker);
    blockersByTurn.set(blocker.turnId, current);
  }
  const convertedTurnIds: string[] = [];
  for (const turn of legacyTurns) {
    convertLegacyTurn(
      db,
      turn,
      blockersByTurn.get(turn.turn_id) ?? [],
      cutoverAt,
    );
    convertedTurnIds.push(turn.turn_id);
  }
  return {
    kind: "completed",
    convertedTurnIds,
    replayedTurnIds: turns
      .filter((turn) =>
        evidenceTurnIds.has(turn.turn_id) && !quarantined.has(turn.turn_id))
      .map((turn) => turn.turn_id),
    preservedTurnIds: turns
      .filter((turn) =>
        !evidenceTurnIds.has(turn.turn_id) &&
        !quarantined.has(turn.turn_id) &&
        isR3PreservedState(turn.semantic_state))
      .map((turn) => turn.turn_id),
    quarantinedTurnIds,
    blockers: publicCutoverBlockers(blockers),
    diagnostics,
  };
}

function quarantineAfterConflict(
  db: Database,
  error: CutoverCasConflict,
  cutoverAt: string,
): LegacyTurnCutoverResult {
  const turns = loadTurns(db);
  const diagnostics: LegacyTurnCutoverDiagnostic[] = turns
    .filter((turn) => isR2OnlyNonterminalState(turn.semantic_state))
    .map((turn) => ({
      turnId: turn.turn_id,
      code: "cutover_cas_conflict" as const,
      semanticState: turn.semantic_state,
      detail: turn.turn_id === error.turnId
        ? error.message
        : "Legacy Turn settlement was quarantined after a concurrent cutover conflict.",
    }));
  recordQuarantines(db, diagnostics, cutoverAt);
  settleDiagnosedTurns(db, turns, diagnostics);
  const quarantinedTurnIds = unique(diagnostics.map((item) => item.turnId));
  return {
    kind: "completed",
    convertedTurnIds: [],
    replayedTurnIds: [],
    preservedTurnIds: turns
      .filter((turn) => isR3PreservedState(turn.semantic_state))
      .map((turn) => turn.turn_id),
    quarantinedTurnIds,
    blockers: [],
    diagnostics,
  };
}

function settleDiagnosedTurns(
  db: Database,
  turns: ReturnType<typeof loadTurns>,
  diagnostics: LegacyTurnCutoverDiagnostic[],
): void {
  const diagnosed = new Set(diagnostics.map((item) => item.turnId));
  for (const turn of turns) {
    if (diagnosed.has(turn.turn_id)) settleQuarantinedTurn(db, turn);
  }
}

function recordQuarantines(
  db: Database,
  diagnostics: LegacyTurnCutoverDiagnostic[],
  quarantinedAt: string,
): void {
  const byTurn = new Map<string, LegacyTurnCutoverDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const current = byTurn.get(diagnostic.turnId) ?? [];
    current.push(diagnostic);
    byTurn.set(diagnostic.turnId, current);
  }
  for (const [turnId, reasons] of byTurn) {
    const reasonJson = stableJson(reasons);
    db.query(`
      INSERT OR IGNORE INTO btcc_r3_legacy_turn_quarantine (
        turn_id, reason_json, reason_sha256, quarantined_at
      ) VALUES (?, ?, ?, ?)
    `).run(turnId, reasonJson, digest(reasonJson), quarantinedAt);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function canonicalTimestamp(value: Date | undefined): string {
  return (value ?? new Date()).toISOString();
}
