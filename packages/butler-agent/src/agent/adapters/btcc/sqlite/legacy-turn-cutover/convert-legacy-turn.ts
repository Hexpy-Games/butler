import type { Database } from "bun:sqlite";
import { digest, stableJson } from "../identity.ts";
import type {
  LegacyTurnCutoverBlocker,
  LegacyTurnCutoverEvidence,
  PendingLegacyTurnCutoverBlocker,
  R2OnlyNonterminalTurnState,
} from "./contracts.ts";
import type { LegacyTurnRow } from "./legacy-turn-preflight.ts";
import {
  preserveLegacyEffectBlockers,
  publicCutoverBlockers,
} from "./preserve-effect-blockers.ts";

type CheckpointRow = {
  checkpoint_revision: number;
};

export class CutoverCasConflict extends Error {
  constructor(readonly turnId: string) {
    super(`Legacy Turn cutover lost its exact CAS: ${turnId}`);
    this.name = "CutoverCasConflict";
  }
}

export function convertLegacyTurn(
  db: Database,
  turn: LegacyTurnRow,
  blockers: PendingLegacyTurnCutoverBlocker[],
  cutoverAt: string,
): void {
  const targetRevision = turn.revision + 1;
  const targetFence = turn.execution_fence + 1;
  const checkpointId = digest(
    `btcc-r3-legacy-cutover-checkpoint.v2\0${turn.turn_id}\0${targetRevision}`,
  );
  const content = limitationMessage(turn.original_message);
  const payloadBody = {
    turnId: turn.turn_id,
    contentSha256: digest(content),
    route: "assisted" as const,
    disposition: "completed" as const,
    content,
  };
  const payloadSha256 = digest(stableJson(payloadBody));
  const payloadId = digest(`btcc-payload.v1\0${payloadSha256}`);
  const finalPayload = { ref: { id: payloadId, sha256: payloadSha256 }, ...payloadBody };
  const outboxId = digest(
    `btcc-canonical-delivery.v1\0${turn.turn_id}\0${targetRevision}\0${payloadSha256}`,
  );
  const expectedMessageId = digest(`btcc-assistant-message.v1\0${outboxId}`);
  const publicBlockers = publicCutoverBlockers(blockers);
  const evidence = buildEvidence(db, turn, publicBlockers, {
    checkpointId,
    revision: targetRevision,
    fence: targetFence,
    cutoverAt,
  });
  const evidenceJson = stableJson(evidence);
  const cutoverId = digest(
    `btcc-r3-legacy-turn-cutover.v2\0${turn.turn_id}\0${turn.revision}`,
  );
  preserveLegacyEffectBlockers(db, turn, blockers, cutoverAt);

  db.query(`
    INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json)
    VALUES (?, 'final_payload', ?, ?)
  `).run(payloadId, payloadSha256, stableJson(finalPayload));
  db.query(`
    INSERT INTO btcc_delivery_outbox (
      outbox_id, turn_id, committed_turn_revision, payload_id, payload_sha256,
      expected_message_id, content, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    outboxId,
    turn.turn_id,
    targetRevision,
    payloadId,
    payloadSha256,
    expectedMessageId,
    content,
  );

  const updated = db.query(`
    UPDATE btcc_turns SET
      semantic_state = 'delivery_committed',
      active_checkpoint_id = ?,
      route = 'assisted',
      final_payload_json = ?,
      delivery_outbox_id = ?,
      canonical_assistant_message_id = NULL,
      revision = ?,
      execution_fence = ?,
      final_disposition = 'completed'
    WHERE turn_id = ? AND semantic_state = ? AND revision = ?
      AND execution_fence = ? AND active_checkpoint_id IS ?
  `).run(
    checkpointId,
    stableJson(finalPayload),
    outboxId,
    targetRevision,
    targetFence,
    turn.turn_id,
    turn.semantic_state,
    turn.revision,
    turn.execution_fence,
    turn.active_checkpoint_id,
  );
  if (updated.changes !== 1) throw new CutoverCasConflict(turn.turn_id);

  db.query(`
    UPDATE btcc_checkpoints SET is_active = 0, active_claim_id = NULL
    WHERE turn_id = ? AND is_active = 1
  `).run(turn.turn_id);
  db.query(`
    UPDATE btcc_state_claims SET status = 'consumed'
    WHERE turn_id = ? AND status != 'consumed'
  `).run(turn.turn_id);
  closeLegacyRuntimeRecords(db, turn.turn_id, cutoverAt);
  db.query(`
    INSERT INTO btcc_checkpoints (
      checkpoint_id, turn_id, turn_revision, semantic_state, kind,
      checkpoint_revision, active_claim_id, is_active
    ) VALUES (?, ?, ?, 'delivery_committed', 'runtime', 0, NULL, 1)
  `).run(checkpointId, turn.turn_id, targetRevision);
  db.query(`
    INSERT INTO btcc_r3_legacy_turn_cutovers (
      cutover_id, turn_id, source_semantic_state, source_turn_revision,
      source_execution_fence, source_active_checkpoint_id,
      admitted_checkpoint_id, admitted_turn_revision,
      admitted_execution_fence, evidence_json, evidence_sha256, cutover_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cutoverId,
    turn.turn_id,
    turn.semantic_state,
    turn.revision,
    turn.execution_fence,
    turn.active_checkpoint_id,
    checkpointId,
    targetRevision,
    targetFence,
    evidenceJson,
    digest(evidenceJson),
    cutoverAt,
  );
}

function buildEvidence(
  db: Database,
  turn: LegacyTurnRow,
  blockers: LegacyTurnCutoverBlocker[],
  target: {
    checkpointId: string;
    revision: number;
    fence: number;
    cutoverAt: string;
  },
): LegacyTurnCutoverEvidence {
  return {
    schema: "btcc.r3.legacy-turn-cutover.v2",
    turnId: turn.turn_id,
    source: {
      semanticState: turn.semantic_state as R2OnlyNonterminalTurnState,
      turnRevision: turn.revision,
      executionFence: turn.execution_fence,
      activeCheckpointId: turn.active_checkpoint_id,
      activeCheckpointRevision: activeCheckpointRevision(
        db,
        turn.active_checkpoint_id,
      ),
      route: turn.route,
      openingAnswerSha256: optionalDigest(turn.opening_answer_json),
      managedStateSha256: optionalDigest(turn.managed_state_json),
      finalPayloadSha256: optionalDigest(turn.final_payload_json),
      goalContractRef: turn.goal_contract_ref,
      finalDossierRef: turn.final_dossier_ref,
      deliveryOutboxId: turn.delivery_outbox_id,
      canonicalAssistantMessageId: turn.canonical_assistant_message_id,
      finalDisposition: turn.final_disposition,
      activeClaimIds: activeRecordIds(
        db,
        "btcc_state_claims",
        "claim_id",
        turn.turn_id,
        "status = 'active'",
      ),
      pendingInterruptionIds: activeRecordIds(
        db,
        "btcc_operational_interruptions",
        "interruption_id",
        turn.turn_id,
        "status IN ('interrupted', 'ready')",
      ),
      openContentionIds: activeRecordIds(
        db,
        "btcc_ledger_contentions",
        "contention_id",
        turn.turn_id,
        "status != 'closed'",
      ),
    },
    target: {
      semanticState: "delivery_committed",
      turnRevision: target.revision,
      executionFence: target.fence,
      checkpointId: target.checkpointId,
      checkpointRevision: 0,
      checkpointKind: "runtime",
    },
    safetyBlockers: blockers,
    cutoverAt: target.cutoverAt,
  };
}

function closeLegacyRuntimeRecords(
  db: Database,
  turnId: string,
  cutoverAt: string,
): void {
  if (tableExists(db, "btcc_operational_interruptions")) {
    db.query(`
      UPDATE btcc_operational_interruptions
      SET status = 'resolved', resolved_at = COALESCE(resolved_at, ?)
      WHERE turn_id = ? AND status IN ('interrupted', 'ready')
    `).run(cutoverAt, turnId);
  }
  if (tableExists(db, "btcc_ledger_contentions")) {
    db.query(`
      UPDATE btcc_ledger_contentions SET status = 'closed'
      WHERE turn_id = ? AND status != 'closed'
    `).run(turnId);
  }
}

function activeCheckpointRevision(
  db: Database,
  checkpointId: string | null,
): number | null {
  if (!checkpointId) return null;
  return db.query<CheckpointRow, [string]>(`
    SELECT checkpoint_revision FROM btcc_checkpoints WHERE checkpoint_id = ?
  `).get(checkpointId)?.checkpoint_revision ?? null;
}

function activeRecordIds(
  db: Database,
  table: string,
  idColumn: string,
  turnId: string,
  condition: string,
): string[] {
  if (!tableExists(db, table)) return [];
  return (db.query(`
    SELECT ${idColumn} AS id FROM ${table}
    WHERE turn_id = ? AND ${condition} ORDER BY ${idColumn}
  `).all(turnId) as Array<{ id: string }>).map((row) => row.id);
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ present: number }, [string]>(`
    SELECT 1 AS present FROM sqlite_schema
    WHERE type = 'table' AND name = ?
  `).get(table));
}

function optionalDigest(value: string | null): string | null {
  return value === null ? null : digest(value);
}

function limitationMessage(originalMessage: string): string {
  return /[가-힣]/u.test(originalMessage)
    ? "이 요청은 이전 BTCC 실행에서 중단되었습니다. 이전 실행의 도구나 외부 효과를 자동으로 반복하지 않았습니다. 새 메시지로 이어서 요청하시면 저장된 Work와 확인된 결과를 바탕으로 계속 진행하겠습니다."
    : "This request stopped in the previous BTCC runtime. I did not automatically repeat its tools or external effects. Send a new message to continue from the saved Work and verified results.";
}
