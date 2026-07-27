import type { Database } from "bun:sqlite";
import type {
  FinalDossierProduct,
  FinalizationContinuation,
  ManagedProgramState,
  PreparedReportProduct,
} from "../../../btcc/gateway-api.ts";
import { ledgerManifestContentHash } from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";
import { preserveStoppedFinalizationRecords } from "./stopped-finalization-record-writer.ts";

export type StoppedTurnSnapshot = {
  semantic_state: string;
  session_id: string;
  context_json: string;
  route: string | null;
  managed_state_json: string | null;
  active_checkpoint_id: string | null;
};

export class StoppedContinuationWriter {
  constructor(private readonly db: Database) {}

  preserve(input: {
    turnId: string;
    turn: StoppedTurnSnapshot;
    program?: ManagedProgramState;
  }): void {
    const { turn, program } = input;
    if (turn.route !== "managed" || !program || program.planningState !== "reviewed") return;
    if (program.frontier === "cancelled") return;
    if (program.frontier === "closed") {
      this.preserveFinalization(input.turnId, turn, program);
      return;
    }
    this.preserveOpenProgram(input.turnId, turn, program);
  }

  private preserveOpenProgram(
    turnId: string,
    turn: StoppedTurnSnapshot,
    program: Extract<ManagedProgramState, { planningState: "reviewed" }>,
  ): void {
    const unfinished = program.tasks.filter((task) => task.status !== "accepted");
    if (unfinished.length === 0) return;
    const interrupted = unfinished.find((task) =>
      task.status === "selected" || task.status === "result_submitted" ||
      task.status === "review_failed");
    const pending = unfinished.filter((task) => task !== interrupted);
    const completed = program.tasks.filter((task) => task.status === "accepted");
    const blocker = this.blocker(turnId, turn.semantic_state, "user_stopped");
    const anchorBody = {
      kind: "user_stopped_program" as const,
      sourceTurnId: turnId,
      programId: program.programId,
      blockerRef: blocker.ref,
      completedTaskRefs: completed.map((task) => task.task.ref),
      ...(interrupted ? { interruptedTaskRef: interrupted.task.ref } : {}),
      pendingTaskRefs: pending.map((task) => task.task.ref),
      openWorkRefs: program.works
        .filter((work) => work.status !== "closed")
        .map((work) => work.work.ref),
    };
    const anchorRef = recordRef("stopped-program-anchor", anchorBody);
    const identity = this.identity("user_stopped", turnId, program, anchorRef, blocker.ref);
    const context = {
      ...this.contextBase(turn, program, blocker.body, anchorBody.openWorkRefs),
      frontier: {
        currentWorkRef: program.currentWork.work.ref,
        ...(interrupted ? { currentTaskRef: interrupted.task.ref } : {}),
        openWorkRefs: anchorBody.openWorkRefs,
        openTaskRefs: unfinished.map((task) => task.task.ref),
        completedTasks: completed.map((task) => continuationTask(task, "reviewed_passed")),
        ...(interrupted
          ? { interruptedTask: continuationTask(interrupted, "interrupted") }
          : {}),
        pendingTasks: pending.map((task) => continuationTask(task, "pending")),
      },
    };
    this.insertRecord(blocker.ref, "user_stopped_program_blocker", blocker.body);
    this.insertRecord(anchorRef, "user_stopped_program_anchor", anchorBody);
    this.insertCandidate("btcc_stopped_program_continuations", {
      ...identity,
      turn,
      context,
    });
  }

  private preserveFinalization(
    turnId: string,
    turn: StoppedTurnSnapshot,
    program: Extract<ManagedProgramState, { planningState: "reviewed" }>,
  ): void {
    const finalization = this.finalizationAtStop(turn, program);
    if (!finalization) return;
    const blocker = this.blocker(turnId, turn.semantic_state, "user_stopped_finalization");
    const anchorBody = {
      kind: "user_stopped_finalization" as const,
      sourceTurnId: turnId,
      programId: program.programId,
      resumeAt: finalization.resumeAt,
      blockerRef: blocker.ref,
      inputRef: finalizationInputRef(finalization, program),
    };
    const anchorRef = recordRef("stopped-finalization-anchor", anchorBody);
    const identity = this.identity(
      "managed_finalization", turnId, program, anchorRef, blocker.ref,
    );
    const context = {
      ...this.contextBase(turn, program, blocker.body, []),
      frontier: { openWorkRefs: [], openTaskRefs: [] },
      finalization,
    };
    preserveStoppedFinalizationRecords(this.db, turn.managed_state_json, finalization);
    this.insertRecord(blocker.ref, "user_stopped_finalization_blocker", blocker.body);
    this.insertRecord(anchorRef, "user_stopped_finalization_anchor", anchorBody);
    this.insertCandidate("btcc_stopped_finalization_continuations", {
      ...identity,
      turn,
      context,
      resumeAt: finalization.resumeAt,
    });
  }

  private finalizationAtStop(
    turn: StoppedTurnSnapshot,
    program: Extract<ManagedProgramState, { planningState: "reviewed" }>,
  ): FinalizationContinuation | null {
    const accepted = this.acceptedPhaseProduct(turn.active_checkpoint_id);
    if (turn.semantic_state === "consolidation") {
      if (isFinalDossier(accepted)) return { resumeAt: "reporting", finalDossier: accepted };
      return { resumeAt: "consolidation", closedProgram: program };
    }
    if (turn.semantic_state !== "reporting") return null;
    if (isPreparedReport(accepted)) return { resumeAt: "delivery", preparedReport: accepted };
    const managed = turn.managed_state_json
      ? JSON.parse(turn.managed_state_json) as { finalDossier?: unknown }
      : {};
    return isFinalDossier(managed.finalDossier)
      ? { resumeAt: "reporting", finalDossier: managed.finalDossier }
      : null;
  }

  private acceptedPhaseProduct(checkpointId: string | null): unknown {
    if (!checkpointId) return null;
    const row = this.db.query<{ accepted_product_json: string | null }, [string]>(`
      SELECT accepted_product_json FROM btcc_checkpoints WHERE checkpoint_id = ?
    `).get(checkpointId);
    return row?.accepted_product_json ? JSON.parse(row.accepted_product_json) : null;
  }

  private blocker(turnId: string, sourceState: string, kind: string) {
    const body = {
      kind,
      sourceTurnId: turnId,
      sourceState,
      reason: "The owning Turn was stopped by the user.",
      readiness: { kind: "fresh_turn_user_intent" as const },
    };
    return { body, ref: recordRef(`${kind}-blocker`, body) };
  }

  private identity(
    continuationKind: "user_stopped" | "managed_finalization",
    turnId: string,
    program: Extract<ManagedProgramState, { planningState: "reviewed" }>,
    anchorRef: Ref,
    blockerRef: Ref,
  ) {
    const baseManifestHash = ledgerManifestContentHash(program, {
      ledgerId: program.ledgerId,
      programId: program.programId,
    });
    const body = {
      continuationKind,
      ledgerId: program.ledgerId,
      programId: program.programId,
      expectedManifestRevision: program.manifestRevision,
      baseManifestHash,
      sourceTurnId: turnId,
      originalGoalContractRef: program.goalContractRef,
      anchorRef,
      blockerRef,
    };
    return {
      ...body,
      candidateId: digest(`btcc-continuation-candidate.v1\0${stableJson(body)}`),
    };
  }

  private contextBase(
    turn: StoppedTurnSnapshot,
    program: Extract<ManagedProgramState, { planningState: "reviewed" }>,
    blocker: { sourceState: string; reason: string; readiness: unknown },
    openWorkRefs: Ref[],
  ) {
    return {
      originalGoalContract: this.loadRecord(program.goalContractRef.id),
      acceptedPlan: program.acceptedPlan,
      blocker: {
        sourceState: blocker.sourceState,
        reason: blocker.reason,
        readiness: blocker.readiness,
      },
      frontier: { openWorkRefs, openTaskRefs: [] as Ref[] },
    };
  }

  private insertCandidate(
    table: "btcc_stopped_program_continuations" |
      "btcc_stopped_finalization_continuations",
    input: ReturnType<StoppedContinuationWriter["identity"]> & {
      turn: StoppedTurnSnapshot;
      context: unknown;
      resumeAt?: FinalizationContinuation["resumeAt"];
    },
  ): void {
    const context = JSON.parse(input.turn.context_json) as { projectRef?: string };
    const scopeKind = context.projectRef ? "project" : "session";
    const scopeId = context.projectRef ?? input.turn.session_id;
    const resumeColumn = table === "btcc_stopped_finalization_continuations"
      ? ", resume_at" : "";
    const resumeValue = table === "btcc_stopped_finalization_continuations" ? ", ?" : "";
    this.db.query(`
      INSERT OR IGNORE INTO ${table} (
        candidate_id, anchor_id, anchor_sha256, blocker_id, blocker_sha256, source_turn_id,
        session_id, scope_kind, scope_id, ledger_id, program_id,
        expected_manifest_revision, base_manifest_hash, goal_contract_ref,
        context_json${resumeColumn}, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${resumeValue}, 'eligible')
    `).run(
      input.candidateId,
      input.anchorRef.id,
      input.anchorRef.sha256,
      input.blockerRef.id,
      input.blockerRef.sha256,
      input.sourceTurnId,
      input.turn.session_id,
      scopeKind,
      scopeId,
      input.ledgerId,
      input.programId,
      input.expectedManifestRevision,
      input.baseManifestHash,
      input.originalGoalContractRef.id,
      stableJson(input.context),
      ...(input.resumeAt ? [input.resumeAt] : []),
    );
  }

  private insertRecord(ref: Ref, kind: string, body: unknown): void {
    this.db.query(`
      INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json)
      VALUES (?, ?, ?, ?)
    `).run(ref.id, kind, ref.sha256, stableJson(body));
  }

  private loadRecord(id: string): Record<string, unknown> | null {
    const row = this.db.query<{ content_json: string }, [string]>(
      "SELECT content_json FROM btcc_records WHERE record_id = ?",
    ).get(id);
    return row ? JSON.parse(row.content_json) : null;
  }
}

type Ref = { id: string; sha256: string };

function finalizationInputRef(
  finalization: FinalizationContinuation,
  program: Extract<ManagedProgramState, { planningState: "reviewed" }>,
): Ref {
  if (finalization.resumeAt === "reporting") return finalization.finalDossier.dossier.ref;
  if (finalization.resumeAt === "delivery") return finalization.preparedReport.report.ref;
  return recordRef("closed-program", {
    ledgerId: program.ledgerId,
    programId: program.programId,
    manifestRevision: program.manifestRevision,
  });
}

function recordRef(kind: string, body: unknown): Ref {
  const bytes = stableJson(body);
  return { id: digest(`btcc-${kind}.v1\0${bytes}`), sha256: digest(bytes) };
}

function continuationTask(
  state: Extract<ManagedProgramState, { planningState: "reviewed" }>["tasks"][number],
  status: "reviewed_passed" | "interrupted" | "pending",
) {
  return {
    task: state.task,
    status,
    dependencyTaskRefs: state.task.dependencyTaskRefs,
    ...(state.currentResult ? { resultRef: state.currentResult.result.ref } : {}),
    ...(state.currentReview ? { reviewRef: state.currentReview.review.ref } : {}),
  };
}

function isFinalDossier(value: unknown): value is FinalDossierProduct {
  return isRecord(value) && value.kind === "final_dossier" && isRecord(value.dossier) &&
    isRef(value.dossier.ref);
}

function isPreparedReport(value: unknown): value is PreparedReportProduct {
  return isRecord(value) && value.kind === "prepared_report" && isRecord(value.report) &&
    isRef(value.report.ref) && isRecord(value.finalPayload) && isRef(value.finalPayload.ref);
}

function isRef(value: unknown): value is Ref {
  return isRecord(value) && typeof value.id === "string" && typeof value.sha256 === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
