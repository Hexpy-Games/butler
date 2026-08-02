import type { Database } from "bun:sqlite";
import type {
  DurableWorkActionProgress,
  WorkStage,
} from "../../../btcc/durable-work/index.ts";
import { stableJson } from "./identity.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";

type ProgressSnapshotInput = {
  workId: string;
  planRevisionId: string;
  stage: WorkStage;
  actionProgress: DurableWorkActionProgress[];
  publicSummary: string;
  nextStep: string;
  resultSequence: number;
  originTurnId: string;
  identity: string;
  now: string;
};

export class GuidedWorkProgressWriter {
  constructor(private readonly db: Database) {}

  assertRevision(workId: string, expected: number): void {
    const current = this.db.query<{ revision: number }, [string]>(`
      SELECT COALESCE(MAX(revision), 0) AS revision
      FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ?
    `).get(workId)?.revision ?? 0;
    if (current !== expected) {
      throw new Error("Durable Work progress changed; use the current Work view");
    }
  }

  insert(input: ProgressSnapshotInput): string {
    const revision = this.db.query<{ revision: number }, [string]>(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS revision
      FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ?
    `).get(input.workId)?.revision ?? 1;
    const checkpointId = guidedWorkRecordId("checkpoint", input.identity);
    this.db.query(`
      INSERT INTO btcc_guided_work_checkpoint_revisions (
        checkpoint_revision_id, work_id, revision, plan_revision_id, stage,
        public_summary, next_step, action_states_json, result_sequence,
        origin_turn_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpointId,
      input.workId,
      revision,
      input.planRevisionId,
      input.stage,
      input.publicSummary,
      input.nextStep,
      stableJson(input.actionProgress),
      input.resultSequence,
      input.originTurnId,
      input.now,
    );
    return checkpointId;
  }
}
