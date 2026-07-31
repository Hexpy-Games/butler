import { Database } from "bun:sqlite";
import { digest, stableJson } from
  "../../../packages/butler-agent/src/agent/adapters/btcc/sqlite/identity.ts";

const FIXTURE_AT = "2026-07-30T00:00:00.000Z";

export function createLegacyR2BtccDatabase(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE btcc_messages (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE btcc_inbound_inbox (
      inbox_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      trigger_key TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      admission_input_hash TEXT NOT NULL,
      command_json TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(session_id, trigger_key)
    );

    CREATE TABLE btcc_records (
      record_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      content_json TEXT NOT NULL
    );

    CREATE TABLE btcc_turns (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      inbox_id TEXT NOT NULL UNIQUE,
      trigger_key TEXT NOT NULL,
      original_message_id TEXT NOT NULL,
      original_message TEXT NOT NULL,
      admission_snapshot_ref TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      context_json TEXT NOT NULL,
      continuation_snapshot_json TEXT NOT NULL,
      semantic_state TEXT NOT NULL,
      active_checkpoint_id TEXT,
      route TEXT,
      opening_answer_json TEXT,
      managed_state_json TEXT,
      final_payload_json TEXT,
      goal_contract_ref TEXT,
      final_dossier_ref TEXT,
      delivery_outbox_id TEXT,
      canonical_assistant_message_id TEXT,
      revision INTEGER NOT NULL,
      execution_fence INTEGER NOT NULL,
      final_disposition TEXT
    );

    CREATE TABLE btcc_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      turn_revision INTEGER NOT NULL,
      semantic_state TEXT NOT NULL,
      kind TEXT NOT NULL,
      checkpoint_revision INTEGER NOT NULL,
      active_claim_id TEXT,
      accepted_product_json TEXT,
      actual_identity_json TEXT,
      is_active INTEGER NOT NULL,
      UNIQUE(turn_id, turn_revision, semantic_state)
    );

    CREATE TABLE btcc_delivery_outbox (
      outbox_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL UNIQUE,
      committed_turn_revision INTEGER NOT NULL,
      payload_id TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL,
      expected_message_id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE btcc_phase_checkpoint_revisions (
      checkpoint_id TEXT NOT NULL,
      checkpoint_revision INTEGER NOT NULL,
      previous_revision_ref TEXT NOT NULL,
      pending_operation_json TEXT,
      state_claim_id TEXT NOT NULL,
      execution_fence INTEGER NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY(checkpoint_id, checkpoint_revision)
    );
  `);
  return db;
}

export function seedLegacyR2Turn(
  db: Database,
  input: {
    turnId: string;
    semanticState: string;
    originalMessage?: string;
    sessionId?: string;
  },
): void {
  const sessionId = input.sessionId ?? "legacy-session";
  const inboxId = `inbox-${input.turnId}`;
  const triggerKey = `trigger-${input.turnId}`;
  const messageId = `message-${input.turnId}`;
  const checkpointId = `checkpoint-${input.turnId}`;
  const snapshotId = `snapshot-${input.turnId}`;
  const goalId = `goal-${input.turnId}`;
  const dossierId = `dossier-${input.turnId}`;
  const originalMessage = input.originalMessage ?? `Continue ${input.turnId}`;

  insertRecord(db, snapshotId, "admission_snapshot", {
    context: legacyContext(),
  });
  insertRecord(db, goalId, "goal_contract", {
    originalMessageId: messageId,
    request: originalMessage,
  });
  insertRecord(db, dossierId, "final_dossier", {
    status: "in_progress",
  });
  db.query(`
    INSERT INTO btcc_messages (
      message_id, session_id, turn_id, role, content, idempotency_key, created_at
    ) VALUES (?, ?, ?, 'user', ?, ?, ?)
  `).run(
    messageId,
    sessionId,
    input.turnId,
    originalMessage,
    `inbound:${sessionId}:${triggerKey}`,
    FIXTURE_AT,
  );
  db.query(`
    INSERT INTO btcc_inbound_inbox (
      inbox_id, session_id, trigger_key, turn_id, admission_input_hash,
      command_json, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'constructed')
  `).run(
    inboxId,
    sessionId,
    triggerKey,
    input.turnId,
    `admission-hash-${input.turnId}`,
    stableJson({ kind: "run", turnId: input.turnId }),
  );
  db.query(`
    INSERT INTO btcc_turns (
      turn_id, session_id, inbox_id, trigger_key, original_message_id,
      original_message, admission_snapshot_ref, model_selection_json,
      context_json, continuation_snapshot_json, semantic_state,
      active_checkpoint_id, route, opening_answer_json, managed_state_json,
      final_payload_json, goal_contract_ref, final_dossier_ref,
      delivery_outbox_id, canonical_assistant_message_id, revision,
      execution_fence, final_disposition
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'managed', ?, ?, NULL, ?, ?,
      NULL, NULL, 7, 11, 'in_progress'
    )
  `).run(
    input.turnId,
    sessionId,
    inboxId,
    triggerKey,
    messageId,
    originalMessage,
    snapshotId,
    stableJson({
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "legacy-controls",
    }),
    stableJson(legacyContext()),
    input.semanticState,
    checkpointId,
    stableJson({ route: "managed" }),
    stableJson({ programId: `program-${input.turnId}` }),
    goalId,
    dossierId,
  );
  db.query(`
    INSERT INTO btcc_checkpoints (
      checkpoint_id, turn_id, turn_revision, semantic_state, kind,
      checkpoint_revision, active_claim_id, accepted_product_json,
      actual_identity_json, is_active
    ) VALUES (?, ?, 7, ?, 'phase', 3, NULL, '{}', '{}', 1)
  `).run(checkpointId, input.turnId, input.semanticState);
}

export function seedPendingLegacyOperation(
  db: Database,
  input: {
    turnId: string;
    requestId: string;
    kind: "external_effect" | "repository_promotion";
    capabilityRef?: string;
    targetScopeRef?: string;
    occurrenceKey?: string;
    effectIntentRef?: { id: string; sha256: string };
    payload?: Record<string, unknown>;
  },
): void {
  db.query(`
    INSERT INTO btcc_phase_checkpoint_revisions (
      checkpoint_id, checkpoint_revision, previous_revision_ref,
      pending_operation_json, state_claim_id, execution_fence, status
    ) VALUES (?, 3, 'previous-revision', ?, 'legacy-claim', 11,
      'pending_operation')
  `).run(
    `checkpoint-${input.turnId}`,
    stableJson({
      kind: "operation_requests",
      requests: [{
        requestId: input.requestId,
        kind: input.kind,
        ...(input.capabilityRef ? { capabilityRef: input.capabilityRef } : {}),
        ...(input.targetScopeRef ? { targetScopeRef: input.targetScopeRef } : {}),
        ...(input.occurrenceKey ? { occurrenceKey: input.occurrenceKey } : {}),
        ...(input.effectIntentRef ? { effectIntentRef: input.effectIntentRef } : {}),
        ...(input.payload ? { input: input.payload } : {}),
      }],
    }),
  );
}

export function seedExistingCanonicalDelivery(
  db: Database,
  input: { turnId: string; content: string },
): void {
  const payloadBody = {
    turnId: input.turnId,
    contentSha256: digest(input.content),
    route: "assisted",
    disposition: "completed",
    content: input.content,
  };
  const payloadSha256 = digest(stableJson(payloadBody));
  const payloadId = digest(`btcc-payload.v1\0${payloadSha256}`);
  const outboxId = `legacy-outbox-${input.turnId}`;
  const messageId = `legacy-assistant-${input.turnId}`;
  const finalPayload = {
    ref: { id: payloadId, sha256: payloadSha256 },
    ...payloadBody,
  };
  db.query(`
    INSERT INTO btcc_records (record_id, kind, sha256, content_json)
    VALUES (?, 'final_payload', ?, ?)
  `).run(payloadId, payloadSha256, stableJson(finalPayload));
  db.query(`
    INSERT INTO btcc_delivery_outbox (
      outbox_id, turn_id, committed_turn_revision, payload_id, payload_sha256,
      expected_message_id, content, status
    ) VALUES (?, ?, 8, ?, ?, ?, ?, 'inserted')
  `).run(
    outboxId,
    input.turnId,
    payloadId,
    payloadSha256,
    messageId,
    input.content,
  );
  const sessionId = db.query<{ session_id: string }, [string]>(`
    SELECT session_id FROM btcc_turns WHERE turn_id = ?
  `).get(input.turnId)?.session_id;
  if (!sessionId) throw new Error(`Legacy Turn is missing: ${input.turnId}`);
  db.query(`
    INSERT INTO btcc_messages (
      message_id, session_id, turn_id, role, content, idempotency_key, created_at
    ) VALUES (?, ?, ?, 'assistant', ?, ?, ?)
  `).run(
    messageId,
    sessionId,
    input.turnId,
    input.content,
    `delivery:${outboxId}`,
    FIXTURE_AT,
  );
  db.query(`
    UPDATE btcc_turns SET final_payload_json = ?, delivery_outbox_id = ?,
      canonical_assistant_message_id = ?, final_disposition = 'completed'
    WHERE turn_id = ?
  `).run(stableJson(finalPayload), outboxId, messageId, input.turnId);
}

export function installCutoverStorageFailure(
  db: Database,
  turnId: string,
): void {
  db.exec(`
    CREATE TRIGGER fixture_reject_legacy_cutover
    BEFORE UPDATE ON btcc_turns
    WHEN OLD.turn_id = '${sqlText(turnId)}'
      AND NEW.semantic_state = 'delivery_committed'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic cutover storage failure');
    END;
  `);
}

export function installOneShotCutoverCasConflict(
  db: Database,
  turnId: string,
): void {
  db.exec(`
    CREATE TRIGGER fixture_force_legacy_cutover_cas
    BEFORE UPDATE ON btcc_turns
    WHEN OLD.turn_id = '${sqlText(turnId)}'
      AND NEW.semantic_state = 'delivery_committed'
      AND NOT EXISTS (
        SELECT 1 FROM btcc_r3_legacy_turn_quarantine
        WHERE turn_id = OLD.turn_id
      )
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);
}

function insertRecord(
  db: Database,
  recordId: string,
  kind: string,
  content: unknown,
): void {
  const contentJson = stableJson(content);
  db.query(`
    INSERT INTO btcc_records (record_id, kind, sha256, content_json)
    VALUES (?, ?, ?, ?)
  `).run(recordId, kind, digest(contentJson), contentJson);
}

function legacyContext() {
  return {
    userRef: "legacy-user",
    profileRefs: [],
    recentFeedbackRefs: [],
    mandatoryHotCacheRefs: [],
    optionalHotCacheRefs: [],
    baselineObservationScopeRefs: [],
    executionPolicy: {
      role: "butler",
      accessMode: "full_access",
      trackingMode: "local",
      requiredNativeToolProfiles: [],
      requiredNativeTools: [],
    },
  };
}

function sqlText(value: string): string {
  return value.replaceAll("'", "''");
}
