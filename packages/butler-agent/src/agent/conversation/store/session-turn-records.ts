import { createHash } from "node:crypto";
import { CONVERSATION_STORE_SCHEMA_VERSION } from "../schema.ts";
import { isoNow } from "../store-internals.ts";
import type {
  BeginTurnInput,
  ConversationTurn,
  FinalizeTurnInput,
  TurnOutcomeCapsule,
  TurnOutcomeCapsuleInput,
} from "../types.ts";
import type { ConversationStoreDependencies } from "./dependencies.ts";
import type { ConversationMessageRecords } from "./message-records.ts";

interface TurnOutcomeRow extends Omit<
  TurnOutcomeCapsule,
  "evidence_refs" | "unresolved_obligations" | "continuation"
> {
  evidence_refs_json: string;
  unresolved_obligations_json: string;
  continuation_json: string | null;
}

export class ConversationSessionTurnRecords {
  constructor(
    private readonly dependencies: ConversationStoreDependencies,
    private readonly messages: ConversationMessageRecords,
  ) {}

  beginTurn(input: BeginTurnInput): ConversationTurn {
    const now = input.now ?? isoNow();
    const sessionId = input.sessionId ?? this.dependencies.idFactory("cs");
    const turnId = input.turnId ?? this.dependencies.idFactory("ct");
    const tx = this.dependencies.db.transaction(() => {
      this.dependencies.internals.upsertSession({
        id: sessionId,
        workspace_id: input.workspaceId ?? null,
        project_id: input.projectId ?? null,
        gateway_origin: input.gateway,
        created_at: now,
        updated_at: now,
        status: "active",
        schema_version: CONVERSATION_STORE_SCHEMA_VERSION,
      });
      this.dependencies.internals.upsertBinding(
        input.gateway,
        input.externalSessionId,
        sessionId,
        now,
      );
      this.dependencies.internals.enqueueProjection(
        sessionId,
        0,
        "conversation.session_bound",
        sessionId,
        now,
      );
      const existingTurn = this.dependencies.internals.getTurn(turnId);
      if (existingTurn) return existingTurn;
      const turn = this.dependencies.internals.insertTurn({
        id: turnId,
        session_id: sessionId,
        seq: this.dependencies.internals.nextSeq("conversation_turns", sessionId),
        actor: input.actor,
        status: "running",
        request_id: input.requestId ?? null,
        started_at: now,
        completed_at: null,
      });
      this.dependencies.internals.enqueueProjection(
        sessionId,
        turn.seq,
        "conversation.turn_started",
        turn.id,
        now,
      );
      return turn;
    });
    return tx() as ConversationTurn;
  }

  finalizeTurn(input: FinalizeTurnInput): ConversationTurn {
    const completedAt = input.completedAt ?? isoNow();
    const status = input.status ?? "complete";
    const tx = this.dependencies.db.transaction(() => {
      const before = this.dependencies.internals.getTurn(input.turnId);
      if (!before) throw new Error(`Conversation turn not found: ${input.turnId}`);
      if (input.outcomeCapsule) this.writeTurnOutcomeInTransaction(input.outcomeCapsule);
      this.dependencies.db
        .query("UPDATE conversation_turns SET status = ?, completed_at = ? WHERE id = ?")
        .run(status, completedAt, input.turnId);
      const turn = this.dependencies.internals.getTurn(input.turnId);
      if (!turn) throw new Error(`Conversation turn not found: ${input.turnId}`);
      return turn;
    });
    return tx() as ConversationTurn;
  }

  readTurn(turnId: string): ConversationTurn | null {
    return this.dependencies.internals.getTurn(turnId);
  }

  readTurnOutcome(turnId: string): TurnOutcomeCapsule | null {
    const row = this.dependencies.db.query<TurnOutcomeRow, [string]>(`
      SELECT * FROM conversation_turn_outcomes WHERE turn_id = ?
    `).get(turnId);
    if (!row) return null;
    const capsule = hydrateTurnOutcome(row);
    return this.turnOutcomeSourceHash(capsule) === capsule.source_hash ? capsule : null;
  }

  writeTurnOutcome(input: TurnOutcomeCapsuleInput): TurnOutcomeCapsule {
    const tx = this.dependencies.db.transaction(() => this.writeTurnOutcomeInTransaction(input));
    return tx() as TurnOutcomeCapsule;
  }

  private writeTurnOutcomeInTransaction(input: TurnOutcomeCapsuleInput): TurnOutcomeCapsule {
    const turn = this.dependencies.internals.getTurn(input.turnId);
    if (!turn) throw new Error(`Conversation turn not found: ${input.turnId}`);
    if (turn.session_id !== input.sessionId) throw new Error("Turn outcome session mismatch");
    const capsule = turnOutcomeCapsuleFromInput(
      input,
      this.dependencies.idFactory("cto"),
      this.messages.referencedMessagesHash([
        input.requestMessageId ?? null,
        input.publicAssistantMessageId ?? null,
      ]),
    );
    const existing = this.readTurnOutcome(input.turnId);
    if (existing) {
      if (input.generation < existing.generation) return existing;
      if (input.generation === existing.generation) {
        if (capsule.source_hash !== existing.source_hash) {
          throw new Error(`Turn outcome generation conflict: ${input.turnId}:${input.generation}`);
        }
        return existing;
      }
    }
    this.dependencies.db.query(`
      INSERT INTO conversation_turn_outcomes (
        id, session_id, turn_id, generation, outcome, source_hash,
        request_message_id, public_assistant_message_id, provider_id, model_ref,
        evidence_refs_json, unresolved_obligations_json, continuation_json, safe_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        id = excluded.id,
        generation = excluded.generation,
        outcome = excluded.outcome,
        source_hash = excluded.source_hash,
        request_message_id = excluded.request_message_id,
        public_assistant_message_id = excluded.public_assistant_message_id,
        provider_id = excluded.provider_id,
        model_ref = excluded.model_ref,
        evidence_refs_json = excluded.evidence_refs_json,
        unresolved_obligations_json = excluded.unresolved_obligations_json,
        continuation_json = excluded.continuation_json,
        safe_code = excluded.safe_code,
        created_at = excluded.created_at
    `).run(
      capsule.id,
      capsule.session_id,
      capsule.turn_id,
      capsule.generation,
      capsule.outcome,
      capsule.source_hash,
      capsule.request_message_id,
      capsule.public_assistant_message_id,
      capsule.provider_id,
      capsule.model_ref,
      JSON.stringify(capsule.evidence_refs),
      JSON.stringify(capsule.unresolved_obligations),
      capsule.continuation ? JSON.stringify(capsule.continuation) : null,
      capsule.safe_code,
      capsule.created_at,
    );
    this.dependencies.internals.enqueueProjection(
      capsule.session_id,
      turn.seq,
      "conversation.turn_outcome_written",
      capsule.id,
      capsule.created_at,
    );
    return capsule;
  }

  private turnOutcomeSourceHash(capsule: TurnOutcomeCapsule): string {
    return turnOutcomeCapsuleSourceHash({
      session_id: capsule.session_id,
      turn_id: capsule.turn_id,
      generation: capsule.generation,
      outcome: capsule.outcome,
      request_message_id: capsule.request_message_id,
      public_assistant_message_id: capsule.public_assistant_message_id,
      provider_id: capsule.provider_id,
      model_ref: capsule.model_ref,
      evidence_refs: capsule.evidence_refs,
      unresolved_obligations: capsule.unresolved_obligations,
      continuation: capsule.continuation,
      safe_code: capsule.safe_code,
    }, this.messages.referencedMessagesHash([
      capsule.request_message_id,
      capsule.public_assistant_message_id,
    ]));
  }
}

function hydrateTurnOutcome(row: TurnOutcomeRow): TurnOutcomeCapsule {
  return {
    id: row.id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    generation: row.generation,
    outcome: row.outcome,
    source_hash: row.source_hash,
    request_message_id: row.request_message_id,
    public_assistant_message_id: row.public_assistant_message_id,
    provider_id: row.provider_id,
    model_ref: row.model_ref,
    evidence_refs: JSON.parse(row.evidence_refs_json) as string[],
    unresolved_obligations: JSON.parse(row.unresolved_obligations_json) as string[],
    continuation: row.continuation_json
      ? JSON.parse(row.continuation_json) as Record<string, unknown>
      : null,
    safe_code: row.safe_code,
    created_at: row.created_at,
  };
}

function turnOutcomeCapsuleFromInput(
  input: TurnOutcomeCapsuleInput,
  id: string,
  referencedMessagesHash: string,
): TurnOutcomeCapsule {
  const canonical = {
    session_id: input.sessionId,
    turn_id: input.turnId,
    generation: Math.max(0, Math.trunc(input.generation)),
    outcome: input.outcome,
    request_message_id: input.requestMessageId ?? null,
    public_assistant_message_id: input.publicAssistantMessageId ?? null,
    provider_id: input.providerId ?? null,
    model_ref: input.modelRef ?? null,
    evidence_refs: [...new Set(input.evidenceRefs ?? [])],
    unresolved_obligations: [...new Set(input.unresolvedObligations ?? [])],
    continuation: input.continuation ?? null,
    safe_code: input.safeCode ?? null,
  };
  return {
    id: input.id ?? id,
    ...canonical,
    source_hash: turnOutcomeCapsuleSourceHash(canonical, referencedMessagesHash),
    created_at: input.createdAt ?? isoNow(),
  };
}

function turnOutcomeCapsuleSourceHash(
  canonical: Omit<TurnOutcomeCapsule, "id" | "source_hash" | "created_at">,
  referencedMessagesHash: string,
): string {
  return createHash("sha256").update(JSON.stringify({
    ...canonical,
    referenced_messages_hash: referencedMessagesHash,
  })).digest("hex");
}
