import type { Database } from "bun:sqlite";
import type { BtccPersistenceTypes } from "../../../../btcc/gateway-api.ts";

type ManagedProgramState = BtccPersistenceTypes["managedProgramState"];
type ContentRef = ManagedProgramState["goalContractRef"];
type ReviewedProgram = Extract<ManagedProgramState, { planningState: "reviewed" }>;
type ManagedTaskState = ReviewedProgram["tasks"][number];
type GoverningSpec = ManagedProgramState["governingSpecs"][number];
type ManagedDeferralProduct = NonNullable<ManagedProgramState["activeDeferral"]>;
type PromotionDeferralProduct = NonNullable<ReviewedProgram["promotionDeferral"]>;

type ProgramRow = {
  goal_contract_ref: string;
  authority_ref: string;
  accepted_plan_ref: string | null;
  accepted_plan_candidate_ref: string | null;
  planning_review_ref: string | null;
  frontier: "unplanned" | "implementation_open" | "promotion_open" | "closed";
  ledger_id: string;
  manifest_revision: number;
  pending_correction_plan_ref: string | null;
  promotion_assembly_refs_json: string | null;
  promotion_permit_ref: string | null;
  active_deferral_ref: string | null;
  promotion_deferral_ref: string | null;
  available_specs_json: string;
  governing_spec_refs_json: string;
};

export class SqliteWorkLedgerProgramReader {
  constructor(private readonly db: Database) {}

  load(programId: string): ManagedProgramState | null {
    const program = this.loadProgramRow(programId);
    if (!program) return null;
    const availableSpecs = JSON.parse(program.available_specs_json);
    const governingSpecRefs: ContentRef[] = JSON.parse(program.governing_spec_refs_json);
    const authority = {
      ledgerId: program.ledger_id,
      programId,
      manifestRevision: program.manifest_revision,
      goalContractRef: this.loadRef(program.goal_contract_ref),
      authorityRef: this.loadRef(program.authority_ref),
      availableSpecs,
      availableSpecRefs: availableSpecs
        .map((spec: { revisionRef: ContentRef }) => spec.revisionRef),
      governingSpecs: governingSpecRefs.map((ref) => this.loadRecord<GoverningSpec>(ref.id)),
      governingSpecRefs,
      requiredOutcomeId: this.loadRecord<{
        requiredOutcome: { outcomeId: string };
      }>(program.goal_contract_ref).requiredOutcome.outcomeId,
    };
    if (!program.accepted_plan_ref || !program.planning_review_ref) {
      return {
        ...authority,
        planningState: "unplanned",
        ...(program.active_deferral_ref
          ? { activeDeferral: this.loadManagedDeferral(program.active_deferral_ref) }
          : {}),
      };
    }
    const plan = this.loadRecord<ReviewedProgram["plan"]>(program.accepted_plan_ref);
    const acceptedPlanRef = program.accepted_plan_candidate_ref ??
      this.loadRecord<{ candidateRef: ContentRef }>(program.planning_review_ref).candidateRef.id;
    const acceptedPlan = this.loadRecord<ReviewedProgram["acceptedPlan"]>(acceptedPlanRef);
    const works = this.loadWorks(programId);
    const tasks = this.loadTasks(programId);
    const currentTask = selectCurrentTask(tasks);
    const currentWork = works.find(
      (candidate) => candidate.work.workLogicalId === currentTask.task.workLogicalId,
    );
    if (!currentWork) throw new Error("Work Ledger current Task has no Work");
    const latestAttempt = currentTask.attempts.at(-1);
    return {
      ...authority,
      planningState: "reviewed",
      acceptedPlan,
      plan,
      planningReviewRef: this.loadRef(program.planning_review_ref),
      works,
      tasks,
      currentWork,
      currentTask,
      criteria: plan.criterionRefs.map((ref) =>
        this.loadRecord(ref.id)) as ReviewedProgram["criteria"],
      verificationQuestions: plan.verificationQuestionRefs.map((ref) =>
        this.loadRecord(ref.id)) as ReviewedProgram["verificationQuestions"],
      artifactLifecycle: this.loadRecord(
        plan.artifactLifecycleRef.id,
      ) as ReviewedProgram["artifactLifecycle"],
      promotionAssemblies: this.loadPromotionAssemblies(
        program.promotion_assembly_refs_json,
      ),
      ...(program.promotion_permit_ref
        ? { promotionPermit: this.loadRecord(program.promotion_permit_ref) }
        : {}),
      frontier: program.frontier === "closed"
        ? "closed"
        : program.frontier === "promotion_open"
          ? "promotion_open"
          : "implementation_open",
      ...(program.pending_correction_plan_ref
        ? { correctionPlanRef: this.loadRef(program.pending_correction_plan_ref) }
        : latestAttempt?.attemptRecord.correctionPlanRef
          ? { correctionPlanRef: latestAttempt.attemptRecord.correctionPlanRef }
          : {}),
      ...(program.active_deferral_ref
        ? { activeDeferral: this.loadManagedDeferral(program.active_deferral_ref) }
        : {}),
      ...(program.promotion_deferral_ref && program.active_deferral_ref
        ? {
            promotionDeferral: this.loadPromotionDeferral(
              program.promotion_deferral_ref,
              program.active_deferral_ref,
            ),
          }
        : {}),
    };
  }

  private loadProgramRow(programId: string): ProgramRow | null {
    return this.db.query<ProgramRow, [string]>(`
      SELECT goal_contract_ref, authority_ref, accepted_plan_ref, accepted_plan_candidate_ref,
        planning_review_ref, frontier, ledger_id, manifest_revision,
        pending_correction_plan_ref, promotion_assembly_refs_json,
        promotion_permit_ref, active_deferral_ref, promotion_deferral_ref,
        available_specs_json, governing_spec_refs_json
      FROM btcc_programs WHERE program_id = ?
    `).get(programId);
  }

  private loadPromotionAssemblies(
    value: string | null,
  ): ReviewedProgram["promotionAssemblies"] {
    if (!value) return [];
    const refs = JSON.parse(value) as Array<{
      candidateRef: ContentRef;
      resolutionRef: ContentRef;
    }>;
    return refs.map((item) => ({
      candidate: this.loadRecord(item.candidateRef.id),
      resolution: this.loadRecord(item.resolutionRef.id),
    })) as ReviewedProgram["promotionAssemblies"];
  }

  private loadManagedDeferral(anchorId: string): ManagedDeferralProduct {
    const anchor = this.loadRecord<ManagedDeferralProduct["anchor"]>(anchorId);
    const blocker = this.loadRecord<ManagedDeferralProduct["blocker"]>(anchor.blockerRef.id);
    return { kind: "managed_deferral", blocker, anchor };
  }

  private loadPromotionDeferral(
    deferralId: string,
    anchorId: string,
  ): PromotionDeferralProduct {
    const base = this.loadManagedDeferral(anchorId);
    return {
      kind: "promotion_deferral",
      deferral: this.loadRecord(deferralId),
      blocker: base.blocker,
      anchor: base.anchor,
    };
  }

  private loadWorks(programId: string, active = true): ReviewedProgram["works"] {
    const rows = this.db.query<{
      work_ref: string;
      status: ReviewedProgram["works"][number]["status"];
    }, [string, number]>(`
      SELECT work_ref, status FROM btcc_work_items
      WHERE program_id = ? AND is_active = ? ORDER BY rowid
    `).all(programId, active ? 1 : 0);
    if (active && rows.length === 0) throw new Error("Work Ledger Program has no Work");
    return rows.map((row) => {
      const ref = JSON.parse(row.work_ref) as ContentRef;
      return { work: this.loadRecord(ref.id), status: row.status };
    }) as ReviewedProgram["works"];
  }

  private loadTasks(programId: string, active = true): ReviewedProgram["tasks"] {
    const rows = this.db.query<{
      task_ref: string;
      status: ManagedTaskState["status"];
      result_ref: string | null;
      review_ref: string | null;
      revalidation_source_json: string | null;
    }, [string, number]>(`
      SELECT task_ref, status, result_ref, review_ref, revalidation_source_json
      FROM btcc_tasks WHERE program_id = ? AND is_active = ? ORDER BY rowid
    `).all(programId, active ? 1 : 0);
    if (active && rows.length === 0) throw new Error("Work Ledger Program has no Task");
    return rows.map((row) => {
      const ref = JSON.parse(row.task_ref) as ContentRef;
      const task = this.loadRecord<ManagedTaskState["task"]>(ref.id);
      return {
        task,
        status: row.status,
        attempts: this.loadAttempts(programId, task.ref.id),
        ...(row.result_ref
          ? { currentResult: { kind: "result_candidate" as const, result: this.loadRecord(row.result_ref) } }
          : {}),
        ...(row.review_ref
          ? { currentReview: { kind: "task_review" as const, review: this.loadRecord(row.review_ref) } }
          : {}),
        ...(row.revalidation_source_json
          ? { revalidationSource: JSON.parse(row.revalidation_source_json) }
          : {}),
      } as ManagedTaskState;
    });
  }

  private loadAttempts(programId: string, taskId: string): ManagedTaskState["attempts"] {
    const rows = this.db.query<{
      attempt_ref: string;
      execution_target_ref: string;
      execution_target_binding_ref: string;
      status: ManagedTaskState["attempts"][number]["status"];
      review_ref: string | null;
    }, [string, string]>(`
      SELECT attempt_ref, execution_target_ref, execution_target_binding_ref, status,
        review_ref
      FROM btcc_attempts WHERE program_id = ? AND task_id = ? ORDER BY rowid
    `).all(programId, taskId);
    return rows.map((row) => {
      const attemptRef = JSON.parse(row.attempt_ref) as ContentRef;
      const targetRef = JSON.parse(row.execution_target_ref) as ContentRef;
      const bindingRef = JSON.parse(row.execution_target_binding_ref) as ContentRef;
      const attempt = this.loadRecord<Record<string, unknown>>(attemptRef.id);
      return {
        attemptRecord: { ...attempt, ref: attemptRef },
        executionTargetRef: targetRef,
        executionTarget: this.loadRecord(targetRef.id),
        executionTargetBinding: this.loadRecord(bindingRef.id),
        ...(row.review_ref
          ? {
              review: {
                kind: "task_review" as const,
                review: this.loadRecord(row.review_ref),
              },
            }
          : {}),
        status: row.status,
      } as ManagedTaskState["attempts"][number];
    });
  }

  private loadRef(id: string): ContentRef {
    const row = this.db.query<{ sha256: string }, [string]>(`
      SELECT sha256 FROM btcc_records WHERE record_id = ?
    `).get(id);
    if (!row) throw new Error(`Work Ledger record is missing: ${id}`);
    return { id, sha256: row.sha256 };
  }

  private loadRecord<T = unknown>(id: string): T {
    const row = this.db.query<{ content_json: string }, [string]>(`
      SELECT content_json FROM btcc_records WHERE record_id = ?
    `).get(id);
    if (!row) throw new Error(`Work Ledger immutable record is missing: ${id}`);
    return JSON.parse(row.content_json) as T;
  }
}

function selectCurrentTask(tasks: ManagedTaskState[]): ManagedTaskState {
  const active = tasks.find((task) =>
    task.status === "selected" ||
    task.status === "result_submitted" ||
    task.status === "review_failed");
  if (active) return active;
  const planned = tasks
    .filter((task) => task.status === "planned")
    .sort((left, right) => left.task.executionOrdinal - right.task.executionOrdinal)[0];
  return planned ?? tasks.at(-1)!;
}
