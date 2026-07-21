import type { Database } from "bun:sqlite";
import type { BtccPersistenceTypes } from "../../../btcc/index.ts";
import { digest, stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";
import { SqliteManagedLedgerWriter } from "./managed-ledger-writer.ts";

type ManagedTransition = Exclude<
  BtccPersistenceTypes["transition"],
  { kind: "activate_opening" | "accept_opening_answer" | "observe_delivery" }
>;
type ManagedTurnState = BtccPersistenceTypes["managedTurnState"];
type TurnRecord = BtccPersistenceTypes["turn"];
type TurnSemanticState = BtccPersistenceTypes["semanticState"];

export class SqliteManagedTransitionWriter {
  private readonly records: SqliteImmutableRecordStore;
  private readonly ledger: SqliteManagedLedgerWriter;

  constructor(private readonly db: Database) {
    this.records = new SqliteImmutableRecordStore(db);
    this.ledger = new SqliteManagedLedgerWriter(db);
  }

  commit(turn: TurnRecord, nextRevision: number, transition: ManagedTransition): void {
    switch (transition.kind) {
      case "accept_opening_continuation": {
        this.insert("opening_projection", transition.product.projection);
        this.db.query(`
          INSERT INTO btcc_opening_projections (
            turn_id, projection_ref, content, content_sha256
          ) VALUES (?, ?, ?, ?)
        `).run(
          turn.turnId,
          transition.product.projection.ref.id,
          transition.product.projection.content,
          transition.product.projection.contentSha256,
        );
        this.advance(turn, nextRevision, transition.successor, {
          opening: transition.product,
        }, { route: "managed" });
        return;
      }
      case "submit_goal_candidate": {
        this.insert("goal_contract_candidate", transition.product.candidate);
        this.insert("goal_contract", transition.product.candidate.proposedContract);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), goalCandidate: transition.product,
        });
        return;
      }
      case "accept_goal_contract":
        this.acceptGoalContract(turn, nextRevision, transition);
        return;
      case "submit_plan_candidate":
        this.insertPlanningCandidate(transition.product.candidate);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), planCandidate: transition.product,
        });
        return;
      case "accept_plan":
        this.acceptPlan(turn, nextRevision, transition);
        return;
      case "select_work_task":
        this.selectTask(turn, nextRevision, transition);
        return;
      case "submit_result":
        this.submitResult(turn, nextRevision, transition);
        return;
      case "pass_task_review":
      case "fail_task_review":
        this.recordTaskReview(turn, nextRevision, transition);
        return;
      case "accept_feedback_intent":
        this.insert("feedback_intent", transition.product.feedbackIntent);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), feedbackIntent: transition.product,
        });
        return;
      case "submit_feedback_plan":
        this.insert("feedback_plan_candidate", transition.product.candidate);
        this.insert("plan", transition.product.candidate.correctionPlan);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), feedbackPlan: transition.product,
        });
        return;
      case "accept_feedback_plan":
        this.acceptFeedbackPlan(turn, nextRevision, transition);
        return;
      case "close_work_frontier":
        this.closeFrontier(turn, nextRevision, transition.successor);
        return;
      case "accept_final_dossier":
        this.insert("final_dossier", transition.product.dossier);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), finalDossier: transition.product,
        }, { finalDossierRef: transition.product.dossier.ref.id });
        return;
      case "accept_prepared_report":
        this.acceptPreparedReport(turn, nextRevision, transition);
        return;
    }
  }

  private acceptGoalContract(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "accept_goal_contract" }>,
  ): void {
    const { goalContract, authority, review } = transition.product;
    this.insert("goal_contract", goalContract);
    this.insert("authority_revision", authority);
    this.insert("goal_contract_review", review);
    this.ledger.createProgram(turn.sessionId, transition.product);
    this.advance(turn, nextRevision, transition.successor, {
      ...requiredManaged(turn), goalAcceptance: transition.product,
    }, { goalContractRef: goalContract.ref.id });
  }

  private acceptPlan(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "accept_plan" }>,
  ): void {
    const candidate = transition.product.candidate;
    this.insert("planning_review", transition.product.review);
    this.ledger.activatePlan(transition.product);
    const program = {
      ledgerId: candidate.ledgerId,
      programId: candidate.programId,
      goalContractRef: candidate.goalContractRef,
      authorityRef: candidate.authorityRef,
      plan: candidate.plan,
      planningReviewRef: transition.product.review.ref,
      work: candidate.work,
      task: candidate.task,
      criterion: candidate.criterion,
      verificationQuestion: candidate.verificationQuestion,
      artifactLifecycle: candidate.artifactLifecycle,
      frontier: "implementation_open" as const,
      workStatus: "planned" as const,
      taskStatus: "planned" as const,
      attempts: [],
    };
    this.advance(turn, nextRevision, transition.successor, {
      ...requiredManaged(turn), planningAcceptance: transition.product, program,
    });
  }

  private selectTask(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "select_work_task" }>,
  ): void {
    const managed = requiredManaged(turn);
    const program = requiredProgram(managed);
    const attempt = transition.attempt;
    this.insert("attempt", {
      ref: attempt.ref,
      taskRef: attempt.taskRef,
      owningTurnId: attempt.owningTurnId,
      createdByTurnRevision: attempt.createdByTurnRevision,
      ...(attempt.previousAttemptRef ? { previousAttemptRef: attempt.previousAttemptRef } : {}),
      ...(attempt.correctionPlanRef ? { correctionPlanRef: attempt.correctionPlanRef } : {}),
    });
    this.insert("task_execution_target", attempt.executionTarget);
    this.insert("attempt_execution_target_binding", attempt.executionTargetBinding);
    this.ledger.selectAttempt(program, attempt);
    this.advance(turn, nextRevision, transition.successor, {
      ...managed,
      program: {
        ...program, workStatus: "active", taskStatus: "selected",
        attempts: [...program.attempts, attempt], currentResult: undefined,
        currentReview: undefined,
      },
    });
  }

  private submitResult(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "submit_result" }>,
  ): void {
    const managed = requiredManaged(turn);
    const program = requiredProgram(managed);
    const result = transition.product;
    this.insert("result_candidate", result.result);
    this.insert("target_state_revision", result.result.observedState);
    this.ledger.submitResult(program, result);
    const attempts = replaceLastAttempt(program, { status: "result_submitted" });
    this.advance(turn, nextRevision, transition.successor, {
      ...managed,
      program: { ...program, taskStatus: "result_submitted", attempts, currentResult: result },
    });
  }

  private recordTaskReview(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "pass_task_review" | "fail_task_review" }>,
  ): void {
    const managed = requiredManaged(turn);
    const program = requiredProgram(managed);
    const review = transition.product;
    this.insert("task_review", review.review);
    this.insert("review_observation", review.review.observation);
    const passed = transition.kind === "pass_task_review";
    const status = passed ? "accepted" : "review_failed";
    this.ledger.recordReview(program, review);
    const attempts = replaceLastAttempt(program, { status });
    this.advance(turn, nextRevision, transition.successor, {
      ...managed,
      program: { ...program, taskStatus: status, attempts, currentReview: review },
    });
  }

  private acceptFeedbackPlan(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "accept_feedback_plan" }>,
  ): void {
    const managed = requiredManaged(turn);
    const program = requiredProgram(managed);
    this.insert("feedback_planning_review", transition.product.review);
    this.ledger.acceptImplementationRepair(program);
    const attempts = replaceLastAttempt(program, { status: "closed_unaccepted" });
    this.advance(turn, nextRevision, transition.successor, {
      ...managed,
      feedbackAcceptance: transition.product,
      program: {
        ...program, taskStatus: "planned", attempts,
        correctionPlanRef: transition.product.candidate.correctionPlan.ref,
      },
    });
  }

  private closeFrontier(turn: TurnRecord, nextRevision: number, successor: "consolidation"): void {
    const managed = requiredManaged(turn);
    const program = requiredProgram(managed);
    if (program.taskStatus !== "accepted") {
      throw new Error("Work Frontier cannot close before the Task is accepted");
    }
    this.ledger.closeFrontier(program);
    this.advance(turn, nextRevision, successor, {
      ...managed, program: { ...program, frontier: "closed", workStatus: "closed" },
    });
  }

  private acceptPreparedReport(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "accept_prepared_report" }>,
  ): void {
    this.insert("prepared_report", transition.product.report);
    this.insert("final_payload", transition.product.finalPayload);
    const outbox = transition.deliveryOutbox;
    this.db.query(`
      INSERT INTO btcc_delivery_outbox (
        outbox_id, turn_id, committed_turn_revision, payload_id, payload_sha256,
        expected_message_id, content, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      outbox.outboxId, turn.turnId, nextRevision, outbox.finalPayloadRef.id,
      outbox.finalPayloadRef.sha256, outbox.expectedMessageId, outbox.content,
    );
    this.advance(turn, nextRevision, transition.successor, {
      ...requiredManaged(turn), preparedReport: transition.product,
    }, { finalPayload: transition.product.finalPayload, finalDisposition: "completed", outboxId: outbox.outboxId });
  }

  private advance(
    turn: TurnRecord,
    nextRevision: number,
    successor: TurnSemanticState,
    managed: ManagedTurnState,
    extra: {
      route?: "managed";
      goalContractRef?: string;
      finalDossierRef?: string;
      finalPayload?: unknown;
      finalDisposition?: "completed";
      outboxId?: string;
    } = {},
  ): void {
    const checkpointId = digest(`btcc-checkpoint.v1\0${turn.turnId}\0${nextRevision}\0${successor}`);
    const updated = this.db.query(`
      UPDATE btcc_turns SET semantic_state = ?, active_checkpoint_id = ?,
        managed_state_json = ?, revision = ?, route = COALESCE(?, route),
        goal_contract_ref = COALESCE(?, goal_contract_ref),
        final_dossier_ref = COALESCE(?, final_dossier_ref),
        final_payload_json = COALESCE(?, final_payload_json),
        final_disposition = COALESCE(?, final_disposition),
        delivery_outbox_id = COALESCE(?, delivery_outbox_id)
      WHERE turn_id = ? AND revision = ?
    `).run(
      successor, checkpointId, stableJson(managed), nextRevision,
      extra.route ?? null, extra.goalContractRef ?? null, extra.finalDossierRef ?? null,
      extra.finalPayload ? stableJson(extra.finalPayload) : null,
      extra.finalDisposition ?? null, extra.outboxId ?? null, turn.turnId, turn.revision,
    );
    if (updated.changes !== 1) throw new Error("BTCC managed transition lost Turn CAS");
    this.db.query(`
      INSERT INTO btcc_checkpoints (
        checkpoint_id, turn_id, turn_revision, semantic_state, kind,
        checkpoint_revision, is_active
      ) VALUES (?, ?, ?, ?, ?, 1, 1)
    `).run(checkpointId, turn.turnId, nextRevision, successor, checkpointKind(successor));
  }

  private insertPlanningCandidate(candidate: Extract<ManagedTransition, { kind: "submit_plan_candidate" }>["product"]["candidate"]): void {
    this.insert("plan_candidate", candidate);
    this.insert("plan", candidate.plan);
    this.insert("work", candidate.work);
    this.insert("task", candidate.task);
    this.insert("acceptance_criterion", candidate.criterion);
    this.insert("verification_question", candidate.verificationQuestion);
    this.insert("artifact_lifecycle_relation", candidate.artifactLifecycle);
    this.insert("planning_candidate_bundle", candidate.bundle);
  }

  private insert<T extends { ref: { id: string; sha256: string } }>(kind: string, value: T): void {
    this.records.insert(value.ref.id, kind, value.ref.sha256, stableJson(value));
  }
}

function requiredManaged(turn: TurnRecord): ManagedTurnState {
  if (!turn.managed) throw new Error(`Managed state is missing at ${turn.semanticState}`);
  return turn.managed;
}

function requiredProgram(managed: ManagedTurnState) {
  if (!managed.program) throw new Error("Managed Program is missing");
  return managed.program;
}

function replaceLastAttempt(
  program: ReturnType<typeof requiredProgram>,
  patch: Partial<ReturnType<typeof requiredProgram>["attempts"][number]>,
) {
  if (program.attempts.length === 0) throw new Error("Managed Program has no Attempt");
  return program.attempts.map((attempt, index) =>
    index === program.attempts.length - 1 ? { ...attempt, ...patch } : attempt,
  );
}

function checkpointKind(state: TurnSemanticState): "runtime" | "phase" {
  return state === "work_frontier" || state === "delivery_committed" ? "runtime" : "phase";
}
