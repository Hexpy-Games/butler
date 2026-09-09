import type { Database } from "bun:sqlite";
import type {
  ConversationPermission,
  AuthorityOperationalCloseReason,
  AuthorityOperationalCloseScope,
  PrincipalAuthorityRepository,
} from "../../../btcc/authority/index.ts";

type AuthorityRecord = Parameters<PrincipalAuthorityRepository["insert"]>[0];

const AUTHORITY_ROW_SELECT = `
  SELECT
    request_id AS requestId, request_ref AS requestRef,
    identity_sha256 AS identitySha256, owner_session_id AS ownerSessionId,
    source_session_id AS sourceSessionId, source_turn_id AS sourceTurnId, source_call_id AS sourceCallId,
    source_work_id AS sourceWorkId, workspace_path AS workspacePath,
    plan_revision_id AS planRevisionId, action_key AS actionKey,
    authority_generation AS authorityGeneration, capability,
    normalized_target AS normalizedTarget, normalized_input_json AS normalizedInputJson,
    model_ref AS modelRef, reasoning_effort AS reasoningEffort, category,
    reason, executable, command_count AS commandCount, decision, allow_scope AS allowScope,
    schedule_client_message_id AS scheduleClientMessageId,
    schedule_input_text AS scheduleInputText,
    private_alternative_input AS privateAlternativeInput, outcome,
    outcome_receipt_json AS outcomeReceiptJson,
    close_reason AS closeReason, close_scope AS closeScope,
    closed_at AS closedAt, created_at AS createdAt, updated_at AS updatedAt
  FROM btcc_authority_requests
`;

export class SqlitePrincipalAuthorityRepository implements PrincipalAuthorityRepository {
  constructor(private readonly db: Database) {}

  hasConversationPermission(grantRef: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM btcc_conversation_permissions WHERE grant_ref = ? AND revoked_at IS NULL").get(grantRef));
  }

  listConversationPermissions(ownerSessionId: string): ConversationPermission[] {
    return this.db.query<ConversationPermission, [string]>(`
      SELECT grant_ref AS grantRef, owner_session_id AS ownerSessionId, workspace_path AS workspacePath,
        scope_key AS scopeKey, title, description, created_at AS createdAt
      FROM btcc_conversation_permissions WHERE owner_session_id = ? AND revoked_at IS NULL
      ORDER BY created_at
    `).all(ownerSessionId);
  }

  revokeConversationPermission(ownerSessionId: string, grantRef: string): void {
    this.db.query(`UPDATE btcc_conversation_permissions SET revoked_at = ?
      WHERE owner_session_id = ? AND grant_ref = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), ownerSessionId, grantRef);
  }

  resumeSource(requestRef: string): ReturnType<PrincipalAuthorityRepository["resumeSource"]> {
    const row = this.db.query<{
      session_id: string; turn_id: string; trigger_key: string; original_message_id: string;
      original_message: string; progress_destination_json: string | null;
    }, [string]>(`
      SELECT turn.session_id, turn.turn_id, turn.trigger_key, turn.original_message_id,
        turn.original_message, turn.progress_destination_json
      FROM btcc_turns turn JOIN btcc_authority_requests request ON request.source_turn_id = turn.turn_id
      WHERE request.request_ref = ? AND request.close_reason IS NULL
        AND request.decision IN ('allowed', 'denied', 'modified')
        AND turn.suspension_reason = 'authority_pending' AND turn.semantic_state = 'admitted'
        AND json_extract(turn.authority_continuation_json, '$.requestRef') = request.request_ref
    `).get(requestRef);
    return row ? {
      sessionId: row.session_id, turnId: row.turn_id, originalEventId: row.trigger_key,
      originalMessageId: row.original_message_id, originalMessage: row.original_message,
      ...(row.progress_destination_json ? { destination: JSON.parse(row.progress_destination_json) } : {}),
    } : null;
  }

  waitingSourceSessions(): string[] {
    return this.db.query<{ session_id: string }, []>(`
      SELECT DISTINCT session_id FROM btcc_turns
      WHERE semantic_state = 'admitted' AND suspension_reason = 'authority_pending'
    `).all().map((row) => row.session_id);
  }

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
      ${AUTHORITY_ROW_SELECT}
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
    this.db.transaction(() => this.insertPendingCall(record)).immediate();
  }

  private insertPendingCall(record: AuthorityRecord): void {
    this.db.query(`
      INSERT INTO btcc_authority_requests (
        request_id, request_ref, identity_sha256, owner_session_id,
        source_session_id, source_turn_id, source_work_id, workspace_path,
        plan_revision_id, action_key, authority_generation, capability,
        normalized_target, normalized_input_json, model_ref, reasoning_effort,
        category, reason, executable, command_count, decision,
        schedule_client_message_id, schedule_input_text, private_alternative_input, outcome,
        outcome_receipt_json, close_reason, close_scope, closed_at,
        created_at, updated_at, source_call_id
      ) VALUES (
        ?, ?, ?, ?,
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
      record.closeReason,
      record.closeScope,
      record.closedAt,
      record.createdAt,
      record.updatedAt,
      record.sourceCallId ?? null,
    );
    if (record.sourceCallId) {
      const pending = this.db.query(`
        UPDATE btcc_guided_tool_calls SET status = 'awaiting_authority'
        WHERE call_id = ? AND turn_id = ? AND status IN ('started', 'awaiting_authority')
      `).run(record.sourceCallId, record.sourceTurnId);
      if (pending.changes !== 1) throw new Error("authority_source_call_not_pending");
    }
  }

  findByPublicRef(requestRef: string): AuthorityRecord | null {
    return this.find("request_ref", requestRef);
  }

  listPending(ownerSessionId: string): AuthorityRecord[] {
    return this.db.query<AuthorityRecord, [string]>(`
      ${AUTHORITY_ROW_SELECT}
      WHERE owner_session_id = ? AND decision = 'pending' AND close_reason IS NULL
        AND source_call_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM btcc_turns turn WHERE turn.turn_id = source_turn_id
          AND turn.suspension_reason = 'authority_pending')
      ORDER BY created_at ASC
    `).all(ownerSessionId);
  }

  listDecided(): AuthorityRecord[] {
    return this.db.query<AuthorityRecord, []>(`
      ${AUTHORITY_ROW_SELECT}
      WHERE decision IN ('allowed', 'denied', 'modified')
        AND source_call_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM btcc_turns turn WHERE turn.turn_id = source_turn_id
          AND turn.suspension_reason = 'authority_pending')
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

  decide(input: Parameters<PrincipalAuthorityRepository["decide"]>[0]): AuthorityRecord | null {
    return this.db.transaction(() => this.commitDecision(input)).immediate();
  }

  private commitDecision(input: Parameters<PrincipalAuthorityRepository["decide"]>[0]): AuthorityRecord | null {
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
      SET decision = ?, schedule_input_text = ?, allow_scope = ?,
        private_alternative_input = CASE WHEN ? = 'modified' THEN ? ELSE private_alternative_input END,
        updated_at = ?
      WHERE request_ref = ? AND owner_session_id = ? AND source_session_id = ?
        AND decision = 'pending' AND close_reason IS NULL
        AND source_call_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM btcc_turns source
          WHERE source.turn_id = btcc_authority_requests.source_turn_id
            AND source.suspension_reason = 'authority_pending'
            AND source.semantic_state = 'admitted'
            AND json_extract(source.authority_continuation_json, '$.requestRef') = request_ref
        )
    `).run(
      decision,
      scheduleInputText,
      input.permission ? "conversation" : "once",
      decision,
      input.alternativeInput ?? null,
      input.now,
      input.requestRef,
      input.ownerSessionId,
      input.sourceSessionId,
    );
    if (updated.changes !== 1) return null;
    if (input.permission) {
      const grant = input.permission;
      this.db.query(`
        INSERT INTO btcc_conversation_permissions
          (grant_ref, owner_session_id, workspace_path, scope_key, title, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(grant_ref) DO UPDATE SET revoked_at = NULL, created_at = excluded.created_at
      `).run(grant.grantRef, grant.ownerSessionId, grant.workspacePath, grant.scopeKey, grant.title, grant.description, grant.createdAt);
    }
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

  closePendingSelfSessionRequests(input: {
    selfSessionId: string;
    reason: AuthorityOperationalCloseReason;
    scope: AuthorityOperationalCloseScope;
    now: string;
  }): number {
    const updated = this.db.query(`
      UPDATE btcc_authority_requests
      SET close_reason = ?, close_scope = ?, closed_at = ?, updated_at = ?
      WHERE owner_session_id = ? AND source_session_id = ?
        AND decision = 'pending' AND close_reason IS NULL
    `).run(
      input.reason,
      input.scope,
      input.now,
      input.now,
      input.selfSessionId,
      input.selfSessionId,
    );
    return updated.changes;
  }

  closePendingSourceWorkRequests(input: {
    sourceWorkId: string;
    reason: AuthorityOperationalCloseReason;
    scope: AuthorityOperationalCloseScope;
    now: string;
  }): number {
    const updated = this.db.query(`
      UPDATE btcc_authority_requests
      SET close_reason = ?, close_scope = ?, closed_at = ?, updated_at = ?
      WHERE source_work_id = ?
        AND decision = 'pending' AND close_reason IS NULL
    `).run(
      input.reason,
      input.scope,
      input.now,
      input.now,
      input.sourceWorkId,
    );
    return updated.changes;
  }

  private find(column: "identity_sha256" | "request_ref", value: string): AuthorityRecord | null {
    const row = this.db.query<AuthorityRecord, [string]>(`
      ${AUTHORITY_ROW_SELECT}
      WHERE ${column} = ?
      LIMIT 1
    `).get(value);
    return row ?? null;
  }
}
