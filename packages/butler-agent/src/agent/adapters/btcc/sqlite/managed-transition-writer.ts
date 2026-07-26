import type { Database } from "bun:sqlite";
import type { BtccPersistenceTypes, WorkLedger, WorkLedgerCommit } from "../../../btcc/gateway-api.ts";
import { stableJson } from "./identity.ts";
import { SqliteImmutableRecordStore } from "./immutable-record-store.ts";
import { ManagedArtifactRecordWriter } from "./managed-artifact-record-writer.ts";
import { ManagedDeliveryOutboxWriter } from "./managed-delivery-outbox-writer.ts";
import { ConsolidationRepairWriter } from "./consolidation-repair-writer.ts";
import { ManagedGoalTransitionWriter } from "./managed-goal-transition-writer.ts";
import { ManagedPlanningRecordWriter } from "./managed-planning-record-writer.ts";
import { ManagedTurnProjectionWriter } from "./managed-turn-projection-writer.ts";
import type { ProjectLedgerBoundaryContext } from "./project-ledger-promotion-writer.ts";
import { ProjectManagedBoundary } from "./project-managed-boundary.ts";
import { StoppedContinuationRegistry } from "./stopped-continuation-registry.ts";
type ManagedTransition = Exclude<BtccPersistenceTypes["transition"],
  {
    kind:
      | "activate_opening"
      | "accept_opening_answer"
      | "accept_opening_continuation"
      | "observe_delivery";
  }>;
type ManagedTurnState = BtccPersistenceTypes["managedTurnState"];
type TurnRecord = BtccPersistenceTypes["turn"];
export class SqliteManagedTransitionWriter {
  private readonly records: SqliteImmutableRecordStore;
  private readonly artifactRecords: ManagedArtifactRecordWriter;
  private readonly delivery: ManagedDeliveryOutboxWriter;
  private readonly consolidationRepairs: ConsolidationRepairWriter;
  private readonly planningRecords: ManagedPlanningRecordWriter;
  private readonly turnProjection: ManagedTurnProjectionWriter;
  private readonly projectBoundary: ProjectManagedBoundary;
  private readonly goals: ManagedGoalTransitionWriter;
  private readonly stoppedContinuations: StoppedContinuationRegistry;
  constructor(private readonly db: Database, ledger: WorkLedger) {
    this.records = new SqliteImmutableRecordStore(db);
    this.artifactRecords = new ManagedArtifactRecordWriter(this.records);
    this.delivery = new ManagedDeliveryOutboxWriter(db, this.records);
    this.consolidationRepairs = new ConsolidationRepairWriter(this.records);
    this.planningRecords = new ManagedPlanningRecordWriter(this.records);
    this.turnProjection = new ManagedTurnProjectionWriter(db);
    this.projectBoundary = new ProjectManagedBoundary(db, ledger);
    this.goals = new ManagedGoalTransitionWriter(
      this.records,
      this.turnProjection,
      this.projectBoundary,
    );
    this.stoppedContinuations = new StoppedContinuationRegistry(db);
  }
  commit(
    turn: TurnRecord,
    nextRevision: number,
    transition: ManagedTransition,
    projectLedger: ProjectLedgerBoundaryContext = {},
  ): void {
    this.prepareProjectPromotion(turn, nextRevision, transition, projectLedger);
    switch (transition.kind) {
      case "submit_goal_candidate":
      case "request_goal_revision":
        this.goals.commit(turn, nextRevision, transition, projectLedger);
        return;
      case "accept_goal_contract":
        this.goals.commit(turn, nextRevision, transition, projectLedger);
        this.consumeStoppedBinding(transition);
        return;
      case "submit_plan_candidate":
        this.planningRecords.record(transition.product.candidate);
        this.projectBoundary.recordPlanningBase(projectLedger);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), planCandidate: transition.product,
        });
        return;
      case "request_plan_revision":
        this.insert("planning_review", transition.product.review);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), planningRevision: transition.product,
        });
        return;
      case "accept_plan":
        this.acceptPlan(turn, nextRevision, transition, projectLedger);
        return;
      case "accept_work_cancellation": {
        this.insert("work_cancellation", transition.product.cancellation);
        const program = this.requireCommittedProgram(
          this.commitLedger(transition.ledgerCommit, projectLedger),
        );
        this.stoppedContinuations.consumeCancellation(
          transition.ledgerCommit.mutation,
          true,
        );
        this.turnProjection.cancelWork(turn, nextRevision, {
          programId: program.programId,
          program,
        });
        return;
      }
      case "select_work_task":
        this.selectTask(turn, nextRevision, transition, projectLedger);
        return;
      case "resume_task_review":
        this.advance(turn, nextRevision, transition.successor, requiredManaged(turn));
        return;
      case "submit_result":
        this.submitResult(turn, nextRevision, transition, projectLedger);
        return;
      case "pass_task_review":
      case "fail_task_review":
        this.recordTaskReview(turn, nextRevision, transition, projectLedger);
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
        if (transition.product.candidate.correctionKind !== "implementation_repair") {
          this.planningRecords.record(transition.product.candidate.nextPlanCandidate);
          if (transition.product.candidate.correctionKind === "authority_scope_revision") {
            this.insert("authority_revision", transition.product.candidate.proposedAuthority);
          }
        }
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), feedbackPlan: transition.product,
        });
        return;
      case "request_feedback_plan_revision":
        this.insert("feedback_planning_review", transition.product.review);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), feedbackPlanningRevision: transition.product,
        });
        return;
      case "accept_feedback_plan":
        this.acceptFeedbackPlan(turn, nextRevision, transition, projectLedger);
        return;
      case "accept_managed_deferral": {
        this.insert("managed_blocker", transition.product.blocker);
        this.insert("deferral_anchor", transition.product.anchor);
        const program = this.requireCommittedProgram(
          this.commitLedger(transition.ledgerCommit, projectLedger),
        );
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), deferral: transition.product, program,
        });
        return;
      }
      case "accept_promotion_deferral": {
        this.insert("managed_blocker", transition.product.blocker);
        this.insert("deferral_anchor", transition.product.anchor);
        this.insert("promotion_deferral", transition.product.deferral);
        const program = this.requireCommittedProgram(
          this.commitLedger(transition.ledgerCommit, projectLedger),
        );
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), program,
        });
        return;
      }
      case "require_consolidation_repair": {
        this.insert("consolidation_assessment", transition.product.assessment);
        this.consolidationRepairs.record(transition);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), consolidationRepair: transition.product,
        });
        return;
      }
      case "close_work_frontier":
        this.closeFrontier(turn, nextRevision, transition, projectLedger);
        return;
      case "accept_final_dossier":
        if (transition.product.assessment) {
          this.insert("consolidation_assessment", transition.product.assessment);
        }
        this.insert("final_dossier", transition.product.dossier);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), finalDossier: transition.product,
        }, { finalDossierRef: transition.product.dossier.ref.id });
        return;
      case "complete_promoted_work":
      case "defer_promoted_work": {
        const program = this.requireCommittedProgram(
          this.commitLedger(transition.ledgerCommit, projectLedger),
        );
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), program,
        });
        return;
      }
      case "accept_prepared_report":
        this.delivery.prepare(turn.turnId, nextRevision, transition);
        this.advance(turn, nextRevision, transition.successor, {
          ...requiredManaged(turn), preparedReport: transition.product,
        }, {
          finalPayload: transition.product.finalPayload,
          finalDisposition: transition.product.finalPayload.disposition,
          outboxId: transition.deliveryOutbox.outboxId,
        });
        return;
    }
  }
  private acceptPlan(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "accept_plan" }>,
    projectLedger: ProjectLedgerBoundaryContext,
  ): void {
    this.insert("planning_review", transition.product.review);
    const program = this.requireCommittedProgram(
      this.commitLedger(transition.ledgerCommit, projectLedger),
    );
    this.advance(turn, nextRevision, transition.successor, {
      ...requiredManaged(turn), planningAcceptance: transition.product, program,
    });
  }

  private selectTask(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "select_work_task" }>,
    projectLedger: ProjectLedgerBoundaryContext,
  ): void {
    const managed = requiredManaged(turn);
    const attempt = transition.attempt;
    this.artifactRecords.recordAttempt(attempt);
    const committed = this.requireCommittedProgram(
      this.commitLedger(transition.ledgerCommit, projectLedger),
    );
    this.advance(turn, nextRevision, transition.successor, {
      ...managed,
      program: committed,
    });
  }

  private submitResult(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "submit_result" }>,
    projectLedger: ProjectLedgerBoundaryContext,
  ): void {
    const managed = requiredManaged(turn);
    const result = transition.product;
    this.artifactRecords.recordResult(result);
    const committed = this.requireCommittedProgram(
      this.commitLedger(transition.ledgerCommit, projectLedger),
    );
    this.advance(turn, nextRevision, transition.successor, {
      ...managed, program: committed,
    });
  }

  private recordTaskReview(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "pass_task_review" | "fail_task_review" }>,
    projectLedger: ProjectLedgerBoundaryContext,
  ): void {
    const managed = requiredManaged(turn);
    const review = transition.product;
    this.artifactRecords.recordReview(review);
    const committed = this.requireCommittedProgram(
      this.commitLedger(transition.ledgerCommit, projectLedger),
    );
    this.advance(turn, nextRevision, transition.successor, {
      ...managed, program: committed,
    });
  }

  private acceptFeedbackPlan(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "accept_feedback_plan" }>,
    projectLedger: ProjectLedgerBoundaryContext,
  ): void {
    const managed = requiredManaged(turn);
    this.insert("feedback_planning_review", transition.product.review);
    const committed = this.requireCommittedProgram(
      this.commitLedger(transition.ledgerCommit, projectLedger),
    );
    this.advance(turn, nextRevision, transition.successor, {
      ...managed,
      feedbackAcceptance: transition.product,
      program: committed,
    });
  }

  private closeFrontier(
    turn: TurnRecord,
    nextRevision: number,
    transition: Extract<ManagedTransition, { kind: "close_work_frontier" }>,
    projectLedger: ProjectLedgerBoundaryContext,
  ): void {
    const managed = requiredManaged(turn);
    this.artifactRecords.recordPromotionAssemblies(transition.promotionAssemblies);
    if (transition.promotionPermit) {
      this.insert("promotion_permit", transition.promotionPermit);
    }
    const committed = this.requireCommittedProgram(
      this.commitLedger(transition.ledgerCommit, projectLedger),
    );
    this.advance(turn, nextRevision, transition.successor, {
      ...managed, program: committed,
    });
  }

  private prepareProjectPromotion(
    turn: TurnRecord,
    nextRevision: number,
    transition: ManagedTransition,
    projectLedger: ProjectLedgerBoundaryContext,
  ): void {
    this.projectBoundary.bindTurnCommit({
      turnId: turn.turnId,
      nextRevision,
      ...("ledgerCommit" in transition ? { commit: transition.ledgerCommit } : {}),
      context: projectLedger,
    });
  }
  private advance(...input: Parameters<ManagedTurnProjectionWriter["advance"]>): void {
    this.turnProjection.advance(...input);
  }

  private consumeStoppedBinding(
    transition: Extract<ManagedTransition, { kind: "accept_goal_contract" }>,
  ): void {
    this.stoppedContinuations.consumeBinding(
      transition.product.authority.managedBinding,
      true,
    );
  }
  private insert<T extends { ref: { id: string; sha256: string } }>(kind: string, value: T): void {
    this.records.insert(value.ref.id, kind, value.ref.sha256, stableJson(value));
  }

  private commitLedger(commit: WorkLedgerCommit, projectLedger: ProjectLedgerBoundaryContext) {
    return this.projectBoundary.commitProgram(commit, projectLedger);
  }

  private requireCommittedProgram<T>(program: T | null): T {
    if (!program) throw new Error("Work Ledger boundary did not return its Program");
    return program;
  }
}
function requiredManaged(turn: TurnRecord): ManagedTurnState {
  if (!turn.managed) throw new Error(`Managed state is missing at ${turn.semanticState}`);
  return turn.managed;
}
