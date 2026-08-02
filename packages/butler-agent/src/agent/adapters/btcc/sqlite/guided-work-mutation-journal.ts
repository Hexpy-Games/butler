import type { Database } from "bun:sqlite";
import { digest, stableJson } from "./identity.ts";

export type GuidedWorkMutationOperation =
  | "replace_plan"
  | "record_checkpoint"
  | "record_review"
  | "attach_tool_result";

type MutationRow = {
  operation: GuidedWorkMutationOperation;
  request_sha256: string;
  work_id: string;
};

export class GuidedWorkMutationJournal {
  constructor(private readonly db: Database) {}

  replayWorkId(
    mutationCallId: string,
    operation: GuidedWorkMutationOperation,
    requestSha256: string,
  ): string | null {
    const mutation = this.db.query<MutationRow, [string]>(`
      SELECT operation, request_sha256, work_id FROM btcc_guided_work_mutations
      WHERE mutation_call_id = ?
    `).get(mutationCallId);
    if (!mutation) return null;
    if (mutation.operation !== operation || mutation.request_sha256 !== requestSha256) {
      throw new Error(`Durable Work mutation identity conflict: ${mutationCallId}`);
    }
    return mutation.work_id;
  }

  record(input: {
    mutationCallId: string;
    operation: GuidedWorkMutationOperation;
    requestSha256: string;
    workId: string;
    recordId: string;
  }): void {
    this.db.query(`
      INSERT INTO btcc_guided_work_mutations (
        mutation_call_id, operation, request_sha256, work_id, record_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.mutationCallId,
      input.operation,
      input.requestSha256,
      input.workId,
      input.recordId,
      new Date().toISOString(),
    );
  }
}

export function guidedWorkMutationFingerprint(
  operation: GuidedWorkMutationOperation,
  input: unknown,
): string {
  return digest(stableJson({ operation, input }));
}
