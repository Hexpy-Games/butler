import type { Database } from "bun:sqlite";
import type {
  BtccRuntimeDependencies,
} from "../../../btcc/index.ts";
import {
  createWorkLedger,
  LedgerContentionInterruption,
  type WorkLedger,
} from "../../../btcc/index.ts";
import { SqliteTransitionWriter } from "./transition-writer.ts";
import { SqliteWorkLedgerStorage } from "./work-ledger/index.ts";
import { SqliteStopController } from "./sqlite-stop-controller.ts";
import {
  ProjectLedgerMutationClaimConflictError,
  ProjectLedgerPublicationClaimConflictError,
  ProjectLedgerHeadConflictError,
  type ProjectWorkLedgerPublicationAdapter,
} from "../project-ledger/index.ts";
import {
  ProjectLedgerPromotionWriter,
} from "./project-ledger-promotion-writer.ts";
import { ProjectLedgerBoundaryPreparer } from "./project-ledger-boundary-preparer.ts";
import { SqliteLedgerContentionRuntime } from "./ledger-contention/index.ts";
import { SqliteStateExecutionClaims } from "./state-execution-claims.ts";
import type { RuntimeOwnerAuthority } from "./runtime-owner/index.ts";

type TurnStateRepository = BtccRuntimeDependencies["turns"];
type TurnRecord = NonNullable<Awaited<ReturnType<TurnStateRepository["findTurn"]>>>;
type StateExecutionClaim = Awaited<
  ReturnType<TurnStateRepository["acquireStateExecutionClaim"]>
>;
type CommitInput = Parameters<TurnStateRepository["commitTransition"]>[0];
type TurnCheckpoint = NonNullable<TurnRecord["checkpoint"]>;
type TurnSemanticState = TurnRecord["semanticState"];

type TurnRow = {
  turn_id: string;
  session_id: string;
  inbox_id: string;
  trigger_key: string;
  original_message_id: string;
  original_message: string;
  model_selection_json: string;
  context_json: string;
  continuation_snapshot_json: string;
  semantic_state: string;
  active_checkpoint_id: string | null;
  route: string | null;
  opening_answer_json: string | null;
  managed_state_json: string | null;
  final_payload_json: string | null;
  delivery_outbox_id: string | null;
  canonical_assistant_message_id: string | null;
  revision: number;
  execution_fence: number;
  final_disposition: string | null;
};

type CheckpointRow = {
  checkpoint_id: string;
  checkpoint_revision: number;
  kind: "runtime" | "phase";
  semantic_state: string;
};

export class SqliteTurnStateRepository implements TurnStateRepository {
  private readonly transitions: SqliteTransitionWriter;
  private readonly workLedger: WorkLedger;
  private readonly stops: SqliteStopController;
  private readonly projectPromotions: ProjectLedgerPromotionWriter;
  private readonly projectBoundaries: ProjectLedgerBoundaryPreparer;
  private readonly contentions: SqliteLedgerContentionRuntime;
  private readonly stateClaims: SqliteStateExecutionClaims;

  constructor(
    private readonly db: Database,
    owner: RuntimeOwnerAuthority,
    private readonly projectLedger?: {
      publications: ProjectWorkLedgerPublicationAdapter;
      resolveProjectRoot(projectRef: string): string;
    },
  ) {
    this.workLedger = createWorkLedger(new SqliteWorkLedgerStorage(db));
    this.transitions = new SqliteTransitionWriter(db, this.workLedger);
    this.stops = new SqliteStopController(db);
    this.projectPromotions = new ProjectLedgerPromotionWriter(db);
    this.projectBoundaries = new ProjectLedgerBoundaryPreparer(db, projectLedger);
    this.contentions = new SqliteLedgerContentionRuntime(db, projectLedger);
    this.stateClaims = new SqliteStateExecutionClaims(db, owner);
  }

  async findTurn(turnId: string): Promise<TurnRecord | null> {
    const row = this.db.query<TurnRow, [string]>(`
      SELECT * FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    if (!row) return null;
    const checkpoint = row.active_checkpoint_id
      ? this.db.query<CheckpointRow, [string]>(`
          SELECT checkpoint_id, checkpoint_revision, kind, semantic_state
          FROM btcc_checkpoints WHERE checkpoint_id = ? AND is_active = 1
        `).get(row.active_checkpoint_id)
      : null;
    const outbox = row.delivery_outbox_id
      ? this.db.query<{
          outbox_id: string;
          payload_id: string;
          payload_sha256: string;
          expected_message_id: string;
          content: string;
          status: "pending" | "inserted" | "observed";
        }, [string]>("SELECT * FROM btcc_delivery_outbox WHERE outbox_id = ?")
          .get(row.delivery_outbox_id)
      : null;
    const managed = row.managed_state_json
      ? await this.reloadManagedProgram(JSON.parse(row.managed_state_json))
      : undefined;
    return {
      turnId: row.turn_id,
      sessionId: row.session_id,
      inboxId: row.inbox_id,
      triggerKey: row.trigger_key,
      originalMessageId: row.original_message_id,
      originalMessage: row.original_message,
      modelSelection: JSON.parse(row.model_selection_json),
      context: JSON.parse(row.context_json),
      continuationCandidates: JSON.parse(row.continuation_snapshot_json),
      semanticState: row.semantic_state as TurnSemanticState,
      ...(checkpoint ? { checkpoint: hydrateCheckpoint(checkpoint) } : {}),
      ...(row.route === "direct" || row.route === "assisted"
        ? { route: row.route }
        : row.route === "managed"
          ? { route: "managed" as const }
          : {}),
      ...(row.opening_answer_json
        ? { openingAnswer: JSON.parse(row.opening_answer_json) }
        : {}),
      ...(managed ? { managed } : {}),
      ...(row.final_payload_json
        ? { finalPayload: JSON.parse(row.final_payload_json) }
        : row.opening_answer_json
          ? { finalPayload: JSON.parse(row.opening_answer_json).finalPayload }
          : {}),
      ...(outbox
        ? {
            deliveryOutbox: {
              outboxId: outbox.outbox_id,
              finalPayloadRef: { id: outbox.payload_id, sha256: outbox.payload_sha256 },
              expectedMessageId: outbox.expected_message_id,
              content: outbox.content,
              status: outbox.status,
            },
          }
        : {}),
      ...(row.canonical_assistant_message_id
        ? { canonicalAssistantMessageId: row.canonical_assistant_message_id }
        : {}),
      revision: row.revision,
      executionFence: row.execution_fence,
      ...(row.final_disposition === "completed" || row.final_disposition === "deferred"
        ? { finalDisposition: row.final_disposition }
        : row.final_disposition === "cancelled"
          ? { finalDisposition: "cancelled" as const }
          : {}),
    };
  }

  async acquireStateExecutionClaim(turn: TurnRecord): Promise<StateExecutionClaim> {
    if (this.projectPromotions.loadPending(turn.turnId)?.status === "pending") {
      throw new Error("BTCC successor is gated by an unobserved Project Ledger promotion");
    }
    return this.stateClaims.acquire(turn);
  }

  async commitTransition(input: CommitInput): Promise<void> {
    let projectLedger;
    try {
      projectLedger = await this.projectBoundaries.prepare(input.transition);
    } catch (error) {
      if (error instanceof ProjectLedgerPublicationClaimConflictError ||
        error instanceof ProjectLedgerMutationClaimConflictError ||
        error instanceof ProjectLedgerHeadConflictError) {
        const contentionId = this.contentions.relinquishBoundary(input, error);
        throw new LedgerContentionInterruption(contentionId, (signal) =>
          this.contentions.waitUntilResolved(contentionId, signal));
      }
      throw error;
    }
    try {
      this.transitions.commit(input, projectLedger);
    } catch (error) {
      if (projectLedger.preparedPublication && this.projectLedger) {
        await this.projectLedger.publications.abort(projectLedger.preparedPublication);
        await this.contentions.scan();
      }
      throw error;
    }
  }

  async activateCommittedSuccessor(turnId: string): Promise<TurnRecord> {
    const pending = this.projectPromotions.loadPending(turnId);
    if (pending?.status === "pending") {
      if (!this.projectLedger) {
        throw new Error("Project Ledger promotion runtime is not composed");
      }
      await this.projectLedger.publications.promoteAndObserve(pending.publication);
      this.projectPromotions.observe(pending.outboxId);
      await this.contentions.scan();
    }
    const turn = await this.findTurn(turnId);
    if (!turn) throw new Error(`BTCC Turn disappeared after commit: ${turnId}`);
    return turn;
  }

  async recoverPendingProjectLedgerPromotions(): Promise<void> {
    if (this.projectLedger) {
      await this.projectLedger.publications.reconcileOrphanedPublications(
        this.projectPromotions.referencedPublicationIds(),
      );
    }
    for (const pending of this.projectPromotions.listPending()) {
      await this.activateCommittedSuccessor(pending.turnId);
    }
    await this.contentions.scan();
  }

  async stopTurn(turnId: string) {
    const outcome = this.stops.stop(turnId);
    if (this.projectPromotions.loadPending(turnId)?.status === "pending") {
      void this.activateCommittedSuccessor(turnId).catch(() => {
        // Stop is already durable. Startup reconciliation retains promotion ownership.
      });
    }
    return outcome;
  }

  private async reloadManagedProgram(
    managed: NonNullable<TurnRecord["managed"]>,
  ): Promise<NonNullable<TurnRecord["managed"]>> {
    const programId = managed.programId
      ?? managed.program?.programId
      ?? managed.planningAcceptance?.candidate.programId;
    if (!programId) return managed;
    const projection = this.db.query<{ project_ref: string }, [string]>(`
      SELECT project_ref FROM btcc_project_program_projections WHERE program_id = ?
    `).get(programId);
    if (projection) {
      if (!this.projectLedger) throw new Error("Project Work Ledger authority is not composed");
      const projectRoot = this.projectLedger.resolveProjectRoot(projection.project_ref);
      const program = await this.projectLedger.publications.loadProgram(projectRoot, programId);
      if (!program) throw new Error("Project Work Ledger authoritative Program is missing");
      return { ...managed, programId, program };
    }
    const program = this.workLedger.loadProgram(programId);
    return program ? { ...managed, programId, program } : managed;
  }

}

function hydrateCheckpoint(row: CheckpointRow): TurnCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    checkpointRevision: row.checkpoint_revision,
    kind: row.kind,
    semanticState: row.semantic_state as TurnSemanticState,
  };
}
