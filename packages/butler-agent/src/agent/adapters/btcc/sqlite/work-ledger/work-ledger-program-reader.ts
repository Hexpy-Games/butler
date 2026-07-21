import type { Database } from "bun:sqlite";
import type { BtccPersistenceTypes } from "../../../../btcc/index.ts";

type ManagedProgramState = BtccPersistenceTypes["managedProgramState"];
type ContentRef = ManagedProgramState["goalContractRef"];

type ProgramRow = {
  goal_contract_ref: string;
  authority_ref: string;
  accepted_plan_ref: string | null;
  planning_review_ref: string | null;
  frontier: "unplanned" | "implementation_open" | "closed";
  ledger_id: string;
  manifest_revision: number;
  pending_correction_plan_ref: string | null;
};

export class SqliteWorkLedgerProgramReader {
  constructor(private readonly db: Database) {}

  load(programId: string): ManagedProgramState | null {
    const program = this.db.query<ProgramRow, [string]>(`
      SELECT goal_contract_ref, authority_ref, accepted_plan_ref,
        planning_review_ref, frontier, ledger_id, manifest_revision,
        pending_correction_plan_ref
      FROM btcc_programs WHERE program_id = ?
    `).get(programId);
    if (!program?.accepted_plan_ref || !program.planning_review_ref) return null;

    const plan = this.loadRecord<Record<string, unknown>>(program.accepted_plan_ref);
    const work = this.loadCurrentWork(programId);
    const task = this.loadCurrentTask(programId);
    const attempts = this.loadAttempts(programId, task.ref.id);
    const currentResult = task.resultRef
      ? {
          kind: "result_candidate" as const,
          result: this.loadRecord(task.resultRef),
        }
      : undefined;
    const currentReview = task.reviewRef
      ? {
          kind: "task_review" as const,
          review: this.loadRecord(task.reviewRef),
        }
      : undefined;
    const latest = attempts.at(-1);

    return {
      ledgerId: program.ledger_id,
      programId,
      manifestRevision: program.manifest_revision,
      goalContractRef: this.loadRef(program.goal_contract_ref),
      authorityRef: this.loadRef(program.authority_ref),
      plan: plan as ManagedProgramState["plan"],
      planningReviewRef: this.loadRef(program.planning_review_ref),
      work: work.record as ManagedProgramState["work"],
      task: task.record as ManagedProgramState["task"],
      criterion: this.loadRecord(refId(plan.criterionRef)) as ManagedProgramState["criterion"],
      verificationQuestion: this.loadRecord(
        refId(plan.verificationQuestionRef),
      ) as ManagedProgramState["verificationQuestion"],
      artifactLifecycle: this.loadRecord(
        refId(plan.artifactLifecycleRef),
      ) as ManagedProgramState["artifactLifecycle"],
      frontier: program.frontier === "closed" ? "closed" : "implementation_open",
      workStatus: work.status,
      taskStatus: task.status,
      attempts,
      ...(currentResult ? { currentResult: currentResult as ManagedProgramState["currentResult"] } : {}),
      ...(currentReview ? { currentReview: currentReview as ManagedProgramState["currentReview"] } : {}),
      ...(program.pending_correction_plan_ref
        ? { correctionPlanRef: this.loadRef(program.pending_correction_plan_ref) }
        : latest?.correctionPlanRef
          ? { correctionPlanRef: latest.correctionPlanRef }
          : {}),
    };
  }

  private loadCurrentWork(programId: string) {
    const row = this.db.query<{
      work_ref: string;
      status: "planned" | "active" | "closed";
    }, [string]>(`
      SELECT work_ref, status FROM btcc_work_items WHERE program_id = ?
    `).get(programId);
    if (!row) throw new Error("Work Ledger Program has no Work");
    const ref = JSON.parse(row.work_ref) as ContentRef;
    return { record: this.loadRecord(ref.id), status: row.status };
  }

  private loadCurrentTask(programId: string) {
    const row = this.db.query<{
      task_ref: string;
      status: ManagedProgramState["taskStatus"];
      result_ref: string | null;
      review_ref: string | null;
    }, [string]>(`
      SELECT task_ref, status, result_ref, review_ref FROM btcc_tasks WHERE program_id = ?
    `).get(programId);
    if (!row) throw new Error("Work Ledger Program has no Task");
    const ref = JSON.parse(row.task_ref) as ContentRef;
    return {
      record: this.loadRecord(ref.id),
      status: row.status,
      resultRef: row.result_ref,
      reviewRef: row.review_ref,
      ref,
    };
  }

  private loadAttempts(programId: string, taskId: string): ManagedProgramState["attempts"] {
    const rows = this.db.query<{
      attempt_ref: string;
      execution_target_ref: string;
      execution_target_binding_ref: string;
      status: ManagedProgramState["attempts"][number]["status"];
    }, [string, string]>(`
      SELECT attempt_ref, execution_target_ref, execution_target_binding_ref, status
      FROM btcc_attempts WHERE program_id = ? AND task_id = ? ORDER BY rowid
    `).all(programId, taskId);
    return rows.map((row) => {
      const attemptRef = JSON.parse(row.attempt_ref) as ContentRef;
      const targetRef = JSON.parse(row.execution_target_ref) as ContentRef;
      const bindingRef = JSON.parse(row.execution_target_binding_ref) as ContentRef;
      const attempt = this.loadRecord<Record<string, unknown>>(attemptRef.id);
      return {
        ...attempt,
        ref: attemptRef,
        executionTargetRef: targetRef,
        executionTarget: this.loadRecord(targetRef.id),
        executionTargetBinding: this.loadRecord(bindingRef.id),
        status: row.status,
      } as ManagedProgramState["attempts"][number];
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

function refId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Work Ledger record has an invalid ref");
  }
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "string") throw new Error("Work Ledger record ref has no id");
  return id;
}
