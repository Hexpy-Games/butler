import type { Database } from "bun:sqlite";
import type { GuidedWorkRow } from "./guided-work-records.ts";

type WorkRelationOperation = "start_work" | "continue_work";

export class GuidedWorkRelationCommandJournal {
  constructor(private readonly db: Database) {}

  replay(
    mutationCallId: string,
    operation: WorkRelationOperation,
    requestSha256: string,
  ): GuidedWorkRow | null {
    const row = this.db.query<{
      operation: string;
      request_sha256: string;
      work_id: string;
    }, [string]>(`
      SELECT operation, request_sha256, work_id
      FROM btcc_guided_work_relation_commands WHERE mutation_call_id = ?
    `).get(mutationCallId);
    if (!row) return null;
    if (row.operation !== operation || row.request_sha256 !== requestSha256) {
      throw new Error(`Durable Work relation identity conflict: ${mutationCallId}`);
    }
    return this.db.query<GuidedWorkRow, [string]>(
      "SELECT * FROM btcc_guided_works WHERE work_id = ?",
    ).get(row.work_id) ?? null;
  }

  record(
    mutationCallId: string,
    operation: WorkRelationOperation,
    requestSha256: string,
    workId: string,
  ): void {
    this.db.query(`
      INSERT INTO btcc_guided_work_relation_commands (
        mutation_call_id, operation, request_sha256, work_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      mutationCallId,
      operation,
      requestSha256,
      workId,
      new Date().toISOString(),
    );
  }
}
