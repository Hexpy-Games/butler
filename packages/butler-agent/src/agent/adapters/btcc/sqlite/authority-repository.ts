import type { Database } from "bun:sqlite";
import type { AuthorityDecisionAction, PrincipalAuthorityRepository } from "../../../btcc/authority/index.ts";

type AuthorityRecord = Parameters<PrincipalAuthorityRepository["insert"]>[0];

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
        schedule_client_message_id AS scheduleClientMessageId,
        schedule_input_text AS scheduleInputText,
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
        category, reason, executable, command_count, decision,
        schedule_client_message_id, schedule_input_text, private_alternative_input, outcome,
        outcome_receipt_json, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
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
      record.scheduleClientMessageId,
      record.scheduleInputText,
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
        schedule_client_message_id AS scheduleClientMessageId,
        schedule_input_text AS scheduleInputText,
        private_alternative_input AS privateAlternativeInput, outcome,
        outcome_receipt_json AS outcomeReceiptJson, created_at AS createdAt,
        updated_at AS updatedAt
      FROM btcc_authority_requests
      WHERE owner_session_id = ? AND decision = 'pending'
      ORDER BY created_at ASC
    `).all(ownerSessionId);
  }

  listDecided(): AuthorityRecord[] {
    return this.db.query<AuthorityRecord, []>(`
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
        schedule_client_message_id AS scheduleClientMessageId,
        schedule_input_text AS scheduleInputText,
        private_alternative_input AS privateAlternativeInput, outcome,
        outcome_receipt_json AS outcomeReceiptJson, created_at AS createdAt,
        updated_at AS updatedAt
      FROM btcc_authority_requests
      WHERE decision IN ('allowed', 'denied', 'modified')
        AND EXISTS (
          SELECT 1 FROM btcc_guided_works work
          WHERE work.work_id = btcc_authority_requests.source_work_id
            AND work.session_id = btcc_authority_requests.source_session_id
            AND work.status IN ('open', 'blocked')
        )
      ORDER BY updated_at ASC
    `).all();
  }

  isSourceWorkEligible(input: {
    sourceSessionId: string;
    sourceWorkId: string;
  }): boolean {
    const row = this.db.query<{ status: string }, [string, string]>(`
      SELECT status FROM btcc_guided_works
      WHERE work_id = ? AND session_id = ?
      LIMIT 1
    `).get(input.sourceWorkId, input.sourceSessionId);
    return row?.status === "open" || row?.status === "blocked";
  }

  decide(input: {
    requestRef: string;
    ownerSessionId: string;
    sourceSessionId: string;
    action: AuthorityDecisionAction;
    alternativeInput?: string;
    now: string;
  }): AuthorityRecord | null {
    const decision = input.action === "allow"
      ? "allowed"
      : input.action === "deny"
        ? "denied"
        : "modified";
    const scheduleInputText = input.action === "allow"
      ? "Continue the approved operation exactly once."
      : input.action === "deny"
        ? "The reviewed command was denied."
        : "Continue with the reviewed alternative.";
    const updated = this.db.query(`
      UPDATE btcc_authority_requests
      SET decision = ?, schedule_input_text = ?,
        private_alternative_input = CASE WHEN ? = 'modified' THEN ? ELSE private_alternative_input END,
        updated_at = ?
      WHERE request_ref = ? AND owner_session_id = ? AND source_session_id = ?
        AND decision = 'pending'
    `).run(
      decision,
      scheduleInputText,
      decision,
      input.alternativeInput ?? null,
      input.now,
      input.requestRef,
      input.ownerSessionId,
      input.sourceSessionId,
    );
    if (updated.changes !== 1) return null;
    return this.find("request_ref", input.requestRef);
  }

  recordOutcome(input: {
    requestRef: string;
    sourceWorkId: string;
    status: "applied" | "failed" | "uncertain";
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
        schedule_client_message_id AS scheduleClientMessageId,
        schedule_input_text AS scheduleInputText,
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
