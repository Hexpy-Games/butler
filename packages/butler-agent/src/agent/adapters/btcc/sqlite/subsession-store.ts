import type { Database } from "bun:sqlite";
import { digest, stableJson } from "../../../btcc/identity/index.ts";
import type {
  DelegationPacket,
  SessionRelation,
  StewardResultCode,
  StewardResultEnvelope,
  StewardResultStatus,
  SubsessionDelegationStore,
} from "../../../btcc/subsessions/index.ts";
import {
  markParentInputDelivered as markOutboxInputDelivered,
  pendingParentInputCount as countPendingParentInputs,
  pendingParentInputForResult as findPendingParentInput,
  pendingParentInputs as listPendingParentInputs,
} from "./subsession-outbox-store.ts";

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
type ResultRow = {
  result_id: string;
  relation_id: string;
  task_id: string;
  child_session_id: string;
  child_turn_id: string;
  status: StewardResultStatus;
  code: StewardResultCode | null;
  summary: string;
  acceptance_evidence_json: string;
  changed_artifacts_json: string;
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

  relationByParentSessionId(parentSessionId: string): SessionRelation | null {
    const row = this.db.query<RelationRow, [string]>(`
      SELECT relation_id, parent_session_id, parent_turn_id, child_session_id,
        anchor_message_id, ordinal, safe_title, created_at
      FROM btcc_session_relations WHERE parent_session_id = ?
      ORDER BY ordinal ASC LIMIT 1
    `).get(parentSessionId);
    return row ?? null;
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

  resultByRelationId(relationId: string): StewardResultEnvelope | null {
    const row = this.db.query<ResultRow, [string]>(`
      SELECT result_id, relation_id, task_id, child_session_id, child_turn_id,
        status, code, summary, acceptance_evidence_json, changed_artifacts_json, created_at
      FROM btcc_steward_results WHERE relation_id = ?
    `).get(relationId);
    if (!row) return null;
    return {
      result_id: row.result_id,
      relation_id: row.relation_id,
      task_id: row.task_id,
      child_session_id: row.child_session_id,
      child_turn_id: row.child_turn_id,
      status: row.status,
      code: row.code ?? null,
      summary: row.summary,
      acceptance_evidence: JSON.parse(row.acceptance_evidence_json) as string[],
      changed_artifacts: JSON.parse(row.changed_artifacts_json) as string[],
      created_at: row.created_at,
    };
  }

  resultIdForRelation(relationId: string): string | null {
    return this.db.query<{ result_id: string }, [string]>(`
      SELECT result_id FROM btcc_steward_results WHERE relation_id = ?
    `).get(relationId)?.result_id ?? null;
  }

  commitResult(input: {
    relation: SessionRelation;
    packet: DelegationPacket | null;
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
    parentChatId: string;
  }): { result: StewardResultEnvelope; parentInput: {
    relation_id: string;
    result_id: string;
    parent_session_id: string;
    parent_turn_id: string;
    parent_chat_id: string;
    message_id: string;
    text: string;
    model_ref: string;
    reasoning_effort: string;
    access_mode: "full_access";
    timestamp: string;
  }; inserted: boolean } {
    const now = new Date().toISOString();
    const summary = safeSummary(input.summary);
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
      created_at: now,
    });
    const parentInput = {
      relation_id: input.relation.relation_id,
      result_id: input.resultId,
      parent_session_id: input.relation.parent_session_id,
      parent_turn_id: deterministicParentTurnId(input.relation.relation_id, input.resultId),
      parent_chat_id: input.parentChatId,
      message_id: parentMessageId,
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
        created_at: now,
      };
      this.db.query(`
        INSERT INTO btcc_steward_results (
          result_id, relation_id, task_id, child_session_id, child_turn_id,
          status, code, summary, acceptance_evidence_json, changed_artifacts_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.result_id,
        result.relation_id,
        result.task_id,
        result.child_session_id,
        result.child_turn_id,
        result.status,
        result.code,
        result.summary,
        stableJson(result.acceptance_evidence),
        stableJson(result.changed_artifacts),
        result.created_at,
      );
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

function safeSummary(value: string): string {
  return value.replace(/\s+/gu, " ").replace(/[\\/]Users[\\/][^ ]+/gu, "workspace artifact").trim().slice(0, 240) || "Steward completed the bounded task.";
}

function renderParentResult(result: StewardResultEnvelope): string {
  return [
    "Subsession result",
    `Status: ${result.status}`,
    ...(result.code ? [`Code: ${result.code}`] : []),
    `Summary: ${result.summary}`,
    `Acceptance evidence: ${result.acceptance_evidence.join("; ")}`,
    `Changed artifacts: ${result.changed_artifacts.join("; ") || "none"}`,
  ].join("\n");
}
