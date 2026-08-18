import type { Database } from "bun:sqlite";
import type { PrincipalAuthorityRepository } from "../../../btcc/authority/index.ts";

type AuthorityRecord = Parameters<PrincipalAuthorityRepository["insert"]>[0];
type FinalAuthorityDecision = Exclude<AuthorityRecord["decision"], "pending">;

function isFinalAuthorityDecision(
  decision: AuthorityRecord["decision"],
): decision is FinalAuthorityDecision {
  return decision === "allowed" || decision === "denied" || decision === "modified";
}

export class SqlitePrincipalAuthorityRepository implements PrincipalAuthorityRepository {
  constructor(private readonly db: Database) {}

  findByIdentity(identitySha256: string): AuthorityRecord | null {
    return this.find("identity_sha256", identitySha256);
  }

  findBySlot(input: {
    sourceWorkId: string;
    planRevisionId: string;
    actionKey: string;
    capability: string;
    authorityGeneration: number;
  }): AuthorityRecord | null {
    const row = this.db.query<AuthorityRecord, [string, string, string, string, number]>(`
      SELECT
        request_id AS requestId, request_ref AS requestRef,
        identity_sha256 AS identitySha256, owner_session_id AS ownerSessionId,
        source_session_id AS sourceSessionId, source_turn_id AS sourceTurnId,
        source_work_id AS sourceWorkId, workspace_path AS workspacePath,
        plan_revision_id AS planRevisionId, action_key AS actionKey,
        authority_generation AS authorityGeneration, capability,
        normalized_target AS normalizedTarget, normalized_input_json AS normalizedInputJson,
        model_ref AS modelRef, reasoning_effort AS reasoningEffort, category,
        reason, executable, command_count AS commandCount, decision,
        schedule_state AS scheduleState, schedule_client_message_id AS scheduleClientMessageId,
        schedule_input_text AS scheduleInputText, schedule_turn_id AS scheduleTurnId,
        private_alternative_input AS privateAlternativeInput, outcome,
        outcome_receipt_json AS outcomeReceiptJson, created_at AS createdAt,
        updated_at AS updatedAt
      FROM btcc_authority_requests
      WHERE source_work_id = ? AND plan_revision_id = ? AND action_key = ?
        AND capability = ? AND authority_generation = ?
      LIMIT 1
    `).get(
      input.sourceWorkId,
      input.planRevisionId,
      input.actionKey,
      input.capability,
      input.authorityGeneration,
    );
    return row ?? null;
  }

  insert(record: AuthorityRecord): void {
    this.db.query(`
      INSERT INTO btcc_authority_requests (
        request_id, request_ref, identity_sha256, owner_session_id,
        source_session_id, source_turn_id, source_work_id, workspace_path,
        plan_revision_id, action_key, authority_generation, capability,
        normalized_target, normalized_input_json, model_ref, reasoning_effort,
        category, reason, executable, command_count, decision, schedule_state,
        schedule_client_message_id, schedule_input_text, schedule_turn_id,
        private_alternative_input, outcome,
        outcome_receipt_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      record.requestId,
      record.requestRef,
      record.identitySha256,
      record.ownerSessionId,
      record.sourceSessionId,
      record.sourceTurnId,
      record.sourceWorkId,
      record.workspacePath,
      record.planRevisionId,
      record.actionKey,
      record.authorityGeneration,
      record.capability,
      record.normalizedTarget,
      record.normalizedInputJson,
      record.modelRef,
      record.reasoningEffort,
      record.category,
      record.reason,
      record.executable,
      record.commandCount,
      record.decision,
      record.scheduleState,
      record.scheduleClientMessageId,
      record.scheduleInputText,
      record.scheduleTurnId,
      record.privateAlternativeInput,
      record.outcome,
      record.outcomeReceiptJson,
      record.createdAt,
      record.updatedAt,
    );
  }

  findByPublicRef(requestRef: string): AuthorityRecord | null {
    return this.find("request_ref", requestRef);
  }

  listPending(ownerSessionId: string): AuthorityRecord[] {
    return this.db.query<AuthorityRecord, [string]>(`
      SELECT
        request_id AS requestId, request_ref AS requestRef,
        identity_sha256 AS identitySha256, owner_session_id AS ownerSessionId,
        source_session_id AS sourceSessionId, source_turn_id AS sourceTurnId,
        source_work_id AS sourceWorkId, workspace_path AS workspacePath,
        plan_revision_id AS planRevisionId, action_key AS actionKey,
        authority_generation AS authorityGeneration, capability,
        normalized_target AS normalizedTarget, normalized_input_json AS normalizedInputJson,
        model_ref AS modelRef, reasoning_effort AS reasoningEffort, category,
        reason, executable, command_count AS commandCount, decision,
        schedule_state AS scheduleState, schedule_client_message_id AS scheduleClientMessageId,
        schedule_input_text AS scheduleInputText, schedule_turn_id AS scheduleTurnId,
        private_alternative_input AS privateAlternativeInput, outcome,
        outcome_receipt_json AS outcomeReceiptJson, created_at AS createdAt,
        updated_at AS updatedAt
      FROM btcc_authority_requests
      WHERE owner_session_id = ? AND decision = 'pending'
      ORDER BY created_at ASC
    `).all(ownerSessionId);
  }

  allow(requestRef: string, ownerSessionId: string, now: string): AuthorityRecord | null {
    const current = this.find("request_ref", requestRef);
    if (!current || current.ownerSessionId !== ownerSessionId) return null;
    if (current.decision === "allowed") return current;
    if (current.decision !== "pending") return null;
    this.db.query(`
      UPDATE btcc_authority_requests
      SET decision = 'allowed', updated_at = ?
      WHERE request_ref = ? AND owner_session_id = ? AND decision = 'pending'
    `).run(now, requestRef, ownerSessionId);
    const updated = this.find("request_ref", requestRef);
    return updated?.ownerSessionId === ownerSessionId && updated.decision === "allowed"
      ? updated
      : null;
  }

  deny(requestRef: string, ownerSessionId: string, now: string): AuthorityRecord | null {
    const current = this.find("request_ref", requestRef);
    if (!current || current.ownerSessionId !== ownerSessionId) return null;
    if (current.decision === "denied") return current;
    if (current.decision !== "pending") return null;
    this.db.query(`
      UPDATE btcc_authority_requests
      SET decision = 'denied', updated_at = ?
      WHERE request_ref = ? AND owner_session_id = ? AND decision = 'pending'
    `).run(now, requestRef, ownerSessionId);
    const updated = this.find("request_ref", requestRef);
    return updated?.ownerSessionId === ownerSessionId && updated.decision === "denied"
      ? updated
      : null;
  }

  modify(
    requestRef: string,
    ownerSessionId: string,
    alternativeInput: string,
    now: string,
  ): AuthorityRecord | null {
    const current = this.find("request_ref", requestRef);
    if (!current || current.ownerSessionId !== ownerSessionId) return null;
    if (current.decision === "modified") {
      return current.privateAlternativeInput === alternativeInput ? current : null;
    }
    if (current.decision !== "pending") return null;
    this.db.query(`
      UPDATE btcc_authority_requests
      SET decision = 'modified', schedule_input_text = ?,
        private_alternative_input = ?, updated_at = ?
      WHERE request_ref = ? AND owner_session_id = ? AND decision = 'pending'
    `).run(
      "Continue with the reviewed alternative.",
      alternativeInput,
      now,
      requestRef,
      ownerSessionId,
    );
    const updated = this.find("request_ref", requestRef);
    return updated?.ownerSessionId === ownerSessionId && updated.decision === "modified"
      ? updated
      : null;
  }

  markScheduled(
    requestRef: string,
    ownerSessionId: string,
    clientMessageId: string,
    turnId: string,
    now: string,
  ): AuthorityRecord | null {
    const current = this.find("request_ref", requestRef);
    if (!current || current.ownerSessionId !== ownerSessionId) return null;
    if (current.scheduleState === "scheduled") {
      return current.scheduleClientMessageId === clientMessageId &&
          current.scheduleTurnId === turnId
        ? current
        : null;
    }
    if (!isFinalAuthorityDecision(current.decision) ||
        current.scheduleClientMessageId !== clientMessageId || !turnId.trim()) {
      return null;
    }
    this.db.query(`
      UPDATE btcc_authority_requests
      SET schedule_state = 'scheduled', schedule_turn_id = ?, updated_at = ?
      WHERE request_ref = ? AND owner_session_id = ? AND decision IN ('allowed', 'denied', 'modified')
        AND schedule_client_message_id = ?
    `).run(turnId, now, requestRef, ownerSessionId, clientMessageId);
    const updated = this.find("request_ref", requestRef);
    return updated?.ownerSessionId === ownerSessionId &&
        isFinalAuthorityDecision(updated.decision) &&
        updated.scheduleState === "scheduled"
      ? updated
      : null;
  }

  recordOutcome(input: {
    requestRef: string;
    sourceWorkId: string;
    status: "applied" | "failed";
    receiptJson?: string;
    now: string;
  }): AuthorityRecord | null {
    this.db.query(`
      UPDATE btcc_authority_requests
      SET outcome = ?, outcome_receipt_json = COALESCE(?, outcome_receipt_json), updated_at = ?
      WHERE request_ref = ? AND source_work_id = ? AND decision = 'allowed'
        AND outcome IN ('pending', 'failed')
    `).run(
      input.status,
      input.receiptJson ?? null,
      input.now,
      input.requestRef,
      input.sourceWorkId,
    );
    return this.find("request_ref", input.requestRef);
  }

  private find(column: "identity_sha256" | "request_ref", value: string): AuthorityRecord | null {
    const row = this.db.query<AuthorityRecord, [string]>(`
      SELECT
        request_id AS requestId, request_ref AS requestRef,
        identity_sha256 AS identitySha256, owner_session_id AS ownerSessionId,
        source_session_id AS sourceSessionId, source_turn_id AS sourceTurnId,
        source_work_id AS sourceWorkId, workspace_path AS workspacePath,
        plan_revision_id AS planRevisionId, action_key AS actionKey,
        authority_generation AS authorityGeneration, capability,
        normalized_target AS normalizedTarget, normalized_input_json AS normalizedInputJson,
        model_ref AS modelRef, reasoning_effort AS reasoningEffort, category,
        reason, executable, command_count AS commandCount, decision,
        schedule_state AS scheduleState, schedule_client_message_id AS scheduleClientMessageId,
        schedule_input_text AS scheduleInputText, schedule_turn_id AS scheduleTurnId,
        private_alternative_input AS privateAlternativeInput, outcome,
        outcome_receipt_json AS outcomeReceiptJson, created_at AS createdAt,
        updated_at AS updatedAt
      FROM btcc_authority_requests
      WHERE ${column} = ?
      LIMIT 1
    `).get(value);
    return row ?? null;
  }
}
