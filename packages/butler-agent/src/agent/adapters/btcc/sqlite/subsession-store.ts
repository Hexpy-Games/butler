import type { Database } from "bun:sqlite";
import { digest, stableJson } from "../../../btcc/identity/index.ts";
import type {
  DelegationPacket,
  SessionRelation,
  StewardResultCode,
  StewardResultEnvelope,
  StewardResultStatus,
  StewardDirection,
  CreateStewardDirectionInput,
  SubsessionDelegationStore,
} from "../../../btcc/subsessions/index.ts";
import {
  markParentInputDelivered as markOutboxInputDelivered,
  pendingParentInputCount as countPendingParentInputs,
  pendingParentInputForResult as findPendingParentInput,
  pendingParentInputs as listPendingParentInputs,
} from "./subsession-outbox-store.ts";
import {
  insertStewardResult,
  readStewardResult,
  renderParentResult,
  safeStewardSummary,
} from "./subsession-result-record.ts";
import { createStewardDirection, consumePendingStewardDirection } from "./subsession-direction-store.ts";

type RelationRow = SessionRelation;
type DelegationRow = {
  delegation_id: string;
  relation_id: string;
  task_id: string;
  child_turn_id: string;
  root_work_id: string;
  packet_json: string;
  created_at: string;
};
export class SqliteSubsessionDelegationStore implements SubsessionDelegationStore {
  constructor(private readonly db: Database) {}

  create(input: {
    relation: SessionRelation;
    packet: DelegationPacket;
    childTurnId: string;
    rootWorkId: string;
  }): void {
    const tx = this.db.transaction(() => {
      const existing = this.relationByDelegationId(input.packet.delegation_id);
      if (existing) return;
      this.db.query(`
        INSERT INTO btcc_session_relations (
          relation_id, parent_session_id, parent_turn_id, child_session_id,
          anchor_message_id, ordinal, safe_title, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.relation.relation_id,
        input.relation.parent_session_id,
        input.relation.parent_turn_id,
        input.relation.child_session_id,
        input.relation.anchor_message_id,
        input.relation.ordinal,
        input.relation.safe_title,
        input.relation.created_at,
      );
      this.db.query(`
        INSERT INTO btcc_subsession_delegations (
          delegation_id, relation_id, task_id, child_turn_id, root_work_id,
          packet_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.packet.delegation_id,
        input.relation.relation_id,
        input.packet.task_id,
        input.childTurnId,
        input.rootWorkId,
        stableJson(input.packet),
        input.relation.created_at,
      );
    });
    tx.immediate();
  }

  relationById(relationId: string): SessionRelation | null {
    const row = this.db.query<RelationRow, [string]>(`
      SELECT relation_id, parent_session_id, parent_turn_id, child_session_id,
        anchor_message_id, ordinal, safe_title, created_at
      FROM btcc_session_relations WHERE relation_id = ?
    `).get(relationId);
    return row ?? null;
  }

  relationByDelegationId(delegationId: string): SessionRelation | null {
    const row = this.db.query<RelationRow, [string]>(`
      SELECT relation_id, parent_session_id, parent_turn_id, child_session_id,
        anchor_message_id, ordinal, safe_title, created_at
      FROM btcc_session_relations
      WHERE relation_id = (
        SELECT relation_id FROM btcc_subsession_delegations WHERE delegation_id = ?
      )
    `).get(delegationId);
    return row ?? null;
  }

  relationsByParentSessionId(parentSessionId: string): SessionRelation[] {
    return this.db.query<RelationRow, [string]>(`
      SELECT relation_id, parent_session_id, parent_turn_id, child_session_id,
        anchor_message_id, ordinal, safe_title, created_at
      FROM btcc_session_relations WHERE parent_session_id = ?
      ORDER BY ordinal ASC
    `).all(parentSessionId);
  }

  relationByChildSessionId(childSessionId: string): SessionRelation | null {
    const row = this.db.query<RelationRow, [string]>(`
      SELECT relation_id, parent_session_id, parent_turn_id, child_session_id,
        anchor_message_id, ordinal, safe_title, created_at
      FROM btcc_session_relations WHERE child_session_id = ?
    `).get(childSessionId);
    return row ?? null;
  }

  packetByRelationId(relationId: string): DelegationPacket | null {
    const row = this.db.query<Pick<DelegationRow, "packet_json">, [string]>(`
      SELECT packet_json FROM btcc_subsession_delegations WHERE relation_id = ?
    `).get(relationId);
    if (!row) return null;
    try {
      const packet = JSON.parse(row.packet_json) as Record<string, unknown>;
      return {
        ...packet,
        ...(packet.execution_mode === undefined ? { execution_mode: "mutation" } : {}),
      } as DelegationPacket;
    } catch {
      // A factual relation with unreadable packet context must fail closed at
      // the Steward admission boundary; never manufacture replacement facts.
      return null;
    }
  }

  rootWorkIdByRelationId(relationId: string): string | null {
    return this.db.query<{ root_work_id: string }, [string]>(`
      SELECT root_work_id FROM btcc_subsession_delegations WHERE relation_id = ?
    `).get(relationId)?.root_work_id ?? null;
  }

  taskIdByRelationId(relationId: string): string | null {
    return this.db.query<{ task_id: string }, [string]>(`
      SELECT task_id FROM btcc_subsession_delegations WHERE relation_id = ?
    `).get(relationId)?.task_id ?? null;
  }

  childTurnIdByRelationId(relationId: string): string | null {
    return this.db.query<{ child_turn_id: string }, [string]>(`
      SELECT child_turn_id FROM btcc_subsession_delegations WHERE relation_id = ?
    `).get(relationId)?.child_turn_id ?? null;
  }

  createDirection(direction: CreateStewardDirectionInput): StewardDirection {
    return createStewardDirection(this.db, direction);
  }

  consumePendingDirection(input: {
    relationId: string;
    childTurnId: string;
  }): StewardDirection | null {
    return consumePendingStewardDirection(this.db, input);
  }

  resultByRelationId(relationId: string): StewardResultEnvelope | null {
    return readStewardResult(this.db, relationId);
  }

  resultIdForRelation(relationId: string): string | null {
    return this.db.query<{ result_id: string }, [string]>(`
      SELECT result_id FROM btcc_steward_results WHERE relation_id = ?
    `).get(relationId)?.result_id ?? null;
  }

  commitResult(input: {
    relation: SessionRelation;
    childTurnId: string;
    resultId: string;
    taskId: string;
    modelRef: string;
    reasoningEffort: string;
    status: StewardResultStatus;
    code: StewardResultCode | null;
    summary: string;
    acceptanceEvidence: string[];
    changedArtifacts: string[];
    commits: string[];
    tests: string[];
    remainingRisks: string[];
    followUpRecommendations: string[];
    detailRefs: string[];
    parentChatId: string;
  }): { result: StewardResultEnvelope; parentInput: {
    relation_id: string;
    result_id: string;
    parent_session_id: string;
    parent_turn_id: string;
    parent_chat_id: string;
    message_id: string;
    safe_title: string;
    text: string;
    model_ref: string;
    reasoning_effort: string;
    access_mode: "full_access";
    timestamp: string;
  }; inserted: boolean } {
    const now = new Date().toISOString();
    const summary = safeStewardSummary(input.summary);
    const parentMessageId = `subsession-result:${input.relation.relation_id}:${input.resultId}`;
    const parentText = renderParentResult({
      result_id: input.resultId,
      relation_id: input.relation.relation_id,
      task_id: input.taskId,
      child_session_id: input.relation.child_session_id,
      child_turn_id: input.childTurnId,
      status: input.status,
      code: input.code,
      summary,
      acceptance_evidence: input.acceptanceEvidence,
      changed_artifacts: input.changedArtifacts,
      commits: input.commits,
      tests: input.tests,
      remaining_risks: input.remainingRisks,
      follow_up_recommendations: input.followUpRecommendations,
      detail_refs: input.detailRefs,
      created_at: now,
    });
    const parentInput = {
      relation_id: input.relation.relation_id,
      result_id: input.resultId,
      parent_session_id: input.relation.parent_session_id,
      parent_turn_id: deterministicParentTurnId(input.relation.relation_id, input.resultId),
      parent_chat_id: input.parentChatId,
      message_id: parentMessageId,
      safe_title: input.relation.safe_title,
      text: parentText,
      model_ref: input.modelRef,
      reasoning_effort: input.reasoningEffort,
      access_mode: "full_access" as const,
      timestamp: now,
    };
    const transaction = this.db.transaction(() => {
      const existing = this.resultByRelationId(input.relation.relation_id);
      if (existing) {
        return { result: existing, inserted: false };
      }
      const result: StewardResultEnvelope = {
        result_id: input.resultId,
        relation_id: input.relation.relation_id,
        task_id: input.taskId,
        child_session_id: input.relation.child_session_id,
        child_turn_id: input.childTurnId,
        status: input.status,
        code: input.code,
        summary,
        acceptance_evidence: input.acceptanceEvidence,
        changed_artifacts: input.changedArtifacts,
        commits: input.commits,
        tests: input.tests,
        remaining_risks: input.remainingRisks,
        follow_up_recommendations: input.followUpRecommendations,
        detail_refs: input.detailRefs,
        created_at: now,
      };
      insertStewardResult(this.db, result);
      this.db.query(`
        INSERT INTO btcc_subsession_outbox (
          outbox_id, relation_id, result_id, parent_session_id, parent_turn_id,
          message_id, input_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        `subsession-outbox:${input.resultId}`,
        input.relation.relation_id,
        input.resultId,
        parentInput.parent_session_id,
        parentInput.parent_turn_id,
        parentInput.message_id,
        stableJson(parentInput),
        now,
      );
      return { result, inserted: true };
    });
    return { ...transaction.immediate(), parentInput };
  }

  pendingParentInputCount(): number {
    return countPendingParentInputs(this.db);
  }

  pendingParentInputs(): Array<{
    result_id: string;
    relation_id: string;
    parent_session_id: string;
    parent_turn_id: string;
    parent_chat_id: string;
    message_id: string;
    safe_title: string;
    text: string;
    model_ref: string;
    reasoning_effort: string;
    access_mode: "full_access";
    timestamp: string;
  }> {
    return listPendingParentInputs(this.db);
  }

  pendingParentInputForResult(resultId: string): {
    relation_id: string;
    result_id: string;
    parent_session_id: string;
    parent_turn_id: string;
    parent_chat_id: string;
    message_id: string;
    safe_title: string;
    text: string;
    model_ref: string;
    reasoning_effort: string;
    access_mode: "full_access";
    timestamp: string;
  } | null {
    return findPendingParentInput(this.db, resultId);
  }

  markParentInputDelivered(resultId: string): void {
    markOutboxInputDelivered(this.db, resultId);
  }
}

function deterministicParentTurnId(relationId: string, resultId: string): string {
  return `synthesis-${digest(`btcc.subsession.synthesis.v1\0${relationId}\0${resultId}`).slice(0, 32)}`;
}
