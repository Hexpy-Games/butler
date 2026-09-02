import type { Database } from "bun:sqlite";
import { readStewardObserverPlan } from "./steward-observer-plan-reader.ts";
import type {
  StewardObserverProgressEvent,
  StewardObserverReader,
  StewardObserverDelegationPresentation,
  StewardObserverRelation,
  StewardObserverSnapshot,
  StewardObserverOperationOutputChunk,
  StewardObserverTurn,
} from "../../../../gateways/app/domain/sessions/steward-observer.ts";
import type { StewardResultView as StewardObserverResult } from
  "../../../../gateways/app/interface/protocol/app-protocol.ts";
import { subsessionParentResultRefs } from "../../../btcc/subsessions/index.ts";
import { publicStewardTerminalFields } from "./steward-observer-terminal-result.ts";
import {
  LocalProcessLiveness,
  type ProcessLiveness,
} from "./runtime-owner/index.ts";
import {
  projectStewardTurnRecovery,
  readRecoverableStewardTurns,
  type StewardRecoveryTurnRow,
} from "./steward-recovery-reader.ts";
import { readStewardOperationOutputChunks } from "./steward-operation-output-reader.ts";
import { readStewardObserverMessages } from "./steward-observer-message-reader.ts";
import type { ChangedFileDetail } from "../../../tools/file-tools/shared/changed-file-detail.ts";

type RelationRow = StewardObserverRelation;

type ProgressRow = {
  event_id: string;
  session_id: string;
  turn_id: string;
  session_sequence: number;
  turn_sequence: number;
  event_json: string;
  created_at: string;
};

type ResultRow = {
  result_id: string;
  relation_id: string;
  task_id: string;
  child_session_id: string;
  child_turn_id: string;
  status: StewardObserverResult["status"];
  code: StewardObserverResult["code"];
  summary: string;
  acceptance_evidence_json: string;
  changed_artifacts_json: string;
  changed_files_json: string;
  created_at: string;
  work_status: string | null;
  final_payload_json: string | null;
};

type DelegationPresentationRow = {
  task_id: string;
  packet_json: string;
};

/**
 * Read-only projection over the durable BTCC relation/session tables. The App
 * never writes through this adapter; BTCC remains the sole owner of child
 * identity, transcript, progress, and result state.
 */
export class SqliteStewardObserverStore implements StewardObserverReader {
  constructor(
    private readonly db: Database,
    private readonly processLiveness: ProcessLiveness = new LocalProcessLiveness(),
  ) {}

  relationsForParent(sessionId: string): StewardObserverRelation[] {
    return this.db
      .query<RelationRow, [string]>(`
        SELECT relation_id, parent_session_id, parent_turn_id, child_session_id,
          anchor_message_id, ordinal, safe_title, created_at
        FROM btcc_session_relations
        WHERE parent_session_id = ?
        ORDER BY ordinal ASC
      `)
      .all(sessionId);
  }

  relationById(relationId: string): StewardObserverRelation | null {
    return this.relation("relation_id", relationId);
  }

  relationForChild(sessionId: string): StewardObserverRelation | null {
    return this.relation("child_session_id", sessionId);
  }

  delegationPresentation(
    relationId: string,
  ): StewardObserverDelegationPresentation | null {
    const row = this.db.query<DelegationPresentationRow, [string]>(`
      SELECT task_id, packet_json
      FROM btcc_subsession_delegations
      WHERE relation_id = ?
    `).get(relationId);
    if (!row) return null;
    try {
      const packet = JSON.parse(row.packet_json) as Record<string, unknown>;
      if (typeof packet.objective !== "string") return null;
      return {
        task_id: row.task_id,
        objective: packet.objective,
      };
    } catch {
      return null;
    }
  }

  isParentResultInput(sessionId: string, text: string): boolean {
    const refs = subsessionParentResultRefs(text);
    if (!refs) return false;
    return Boolean(this.db.query<{ present: number }, [string, string, string]>(`
      SELECT 1 AS present
      FROM btcc_steward_results AS result
      JOIN btcc_session_relations AS relation
        ON relation.relation_id = result.relation_id
      WHERE relation.parent_session_id = ?
        AND relation.relation_id = ?
        AND result.result_id = ?
      LIMIT 1
    `).get(sessionId, refs.relationId, refs.resultId));
  }

  snapshot(sessionId: string): StewardObserverSnapshot | null {
    const relation = this.relationForChild(sessionId);
    if (!relation) return null;
    const messages = readStewardObserverMessages(this.db, relation);
    const turns = this.db
      .query<StewardRecoveryTurnRow, [string, string]>(`
        SELECT t.turn_id, t.semantic_state, t.trigger_key, t.original_message_id,
          t.original_message, COALESCE(
          (SELECT created_at FROM btcc_progress_events p
            WHERE p.turn_id = t.turn_id ORDER BY p.turn_sequence ASC LIMIT 1),
          ?
        ) AS created_at,
          claim.claim_id, claim.status AS claim_status, claim.owner_id,
          claim.owner_generation, claim.lease_generation,
          owner.host_id AS owner_host_id, owner.process_id AS owner_process_id,
          owner.process_started_at_ms AS owner_process_started_at_ms,
          owner.status AS owner_status
        FROM btcc_turns t
        LEFT JOIN btcc_checkpoints AS checkpoint
          ON checkpoint.checkpoint_id = t.active_checkpoint_id
         AND checkpoint.is_active = 1
        LEFT JOIN btcc_state_claims AS claim
          ON claim.claim_id = checkpoint.active_claim_id
        LEFT JOIN btcc_runtime_owners AS owner
          ON owner.owner_id = claim.owner_id
        WHERE t.session_id = ?
        ORDER BY t.rowid ASC
      `)
      .all(relation.created_at, sessionId)
      .map<StewardObserverTurn>((turn) => ({
        id: turn.turn_id,
        state: turn.semantic_state,
        created_at: turn.created_at,
        updated_at: turn.created_at,
        ...(turn.semantic_state === "admitted"
          ? { recovery: projectStewardTurnRecovery(turn, this.processLiveness) }
          : {}),
      }));
    const progressEvents = this.db
      .query<ProgressRow, [string]>(`
        SELECT event_id, session_id, turn_id, session_sequence, turn_sequence,
          event_json, created_at
        FROM btcc_progress_events
        WHERE session_id = ?
        ORDER BY session_sequence ASC, event_id ASC
      `)
      .all(sessionId)
      .flatMap((row) => this.parseProgress(row));
    const result = this.resultForRelation(relation.relation_id);
    const plan = readStewardObserverPlan(this.db, sessionId);
    const waitingForChildren = Boolean(this.db.query<{ present: number }, [string]>(`
      SELECT 1 AS present
      FROM btcc_session_relations AS child
      LEFT JOIN btcc_steward_results AS result
        ON result.relation_id = child.relation_id
      WHERE child.parent_session_id = ? AND result.result_id IS NULL
      LIMIT 1
    `).get(sessionId));
    const updatedAt = latestTimestamp([
      relation.created_at,
      ...messages.map((message) => message.updated_at),
      ...progressEvents.map((event) => event.created_at),
      ...(result ? [result.created_at] : []),
    ]);
    return {
      session_id: sessionId,
      title: relation.safe_title,
      turns,
      messages,
      progress_events: progressEvents,
      plan,
      result,
      waiting_for_children: waitingForChildren,
      updated_at: updatedAt,
    };
  }

  recoverableTurns(): Array<{
    relation: StewardObserverRelation;
    turn_id: string;
    recovery_id: string;
    original_event_id: string;
    original_message_id: string;
    original_message: string;
  }> {
    return readRecoverableStewardTurns(this.db, this.processLiveness);
  }

  readOperationOutputChunks(input: {
    turnId: string;
    requestId: string;
    resultId: string;
  }): StewardObserverOperationOutputChunk[] {
    return readStewardOperationOutputChunks(this.db, input);
  }

  private relation(
    field: "child_session_id" | "relation_id",
    sessionId: string,
  ): StewardObserverRelation | null {
    const row = this.db
      .query<RelationRow, [string]>(`
        SELECT relation_id, parent_session_id, parent_turn_id, child_session_id,
          anchor_message_id, ordinal, safe_title, created_at
        FROM btcc_session_relations
        WHERE ${field} = ?
        ORDER BY ordinal ASC
        LIMIT 1
      `)
      .get(sessionId);
    return row ?? null;
  }

  private resultForRelation(relationId: string): StewardObserverResult | null {
    const row = this.db
      .query<ResultRow, [string]>(`
        SELECT result.result_id, result.relation_id, result.task_id,
          result.child_session_id, result.child_turn_id, result.status,
          result.code, result.summary, result.acceptance_evidence_json,
          result.changed_artifacts_json, result.changed_files_json,
          result.created_at,
          work.status AS work_status, turn.final_payload_json
        FROM btcc_steward_results AS result
        LEFT JOIN btcc_guided_turn_work_bindings AS binding
          ON binding.turn_id = result.child_turn_id AND binding.is_current = 1
        LEFT JOIN btcc_guided_works AS work ON work.work_id = binding.work_id
        LEFT JOIN btcc_turns AS turn ON turn.turn_id = result.child_turn_id
        WHERE result.relation_id = ?
      `)
      .get(relationId);
    if (!row) return null;
    return {
      result_id: row.result_id,
      relation_id: row.relation_id,
      task_id: row.task_id,
      child_session_id: row.child_session_id,
      child_turn_id: row.child_turn_id,
      ...publicStewardTerminalFields({
        status: row.status,
        code: row.code,
        summary: row.summary,
        workStatus: row.work_status,
        finalPayloadJson: row.final_payload_json,
      }),
      acceptance_evidence: parseStringList(row.acceptance_evidence_json),
      changed_artifacts: parseStringList(row.changed_artifacts_json),
      changed_files: parseChangedFiles(row.changed_files_json),
      created_at: row.created_at,
    };
  }

  private parseProgress(row: ProgressRow): StewardObserverProgressEvent[] {
    try {
      const event = JSON.parse(row.event_json) as {
        kind?: unknown;
        visibility?: unknown;
        payload?: unknown;
      };
      if (typeof event.kind !== "string" ||
        (event.visibility !== "public" && event.visibility !== "internal")) return [];
      return [{
        id: row.event_id,
        session_id: row.session_id,
        turn_id: row.turn_id,
        session_sequence: row.session_sequence,
        turn_sequence: row.turn_sequence,
        kind: event.kind,
        visibility: event.visibility,
        payload: isRecord(event.payload) ? event.payload : {},
        created_at: row.created_at,
      }];
    } catch {
      return [];
    }
  }

}

function parseStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseChangedFiles(value: string): ChangedFileDetail[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as ChangedFileDetail[] : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function latestTimestamp(values: string[]): string {
  return values.reduce(
    (latest, value) => (value > latest ? value : latest),
    values[0] ?? new Date(0).toISOString(),
  );
}
