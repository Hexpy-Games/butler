import type { Database } from "bun:sqlite";
import type { AttachToolResultInput } from "../../../btcc/durable-work/index.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";

type ToolResultRow = {
  turn_id: string;
  tool_name: string;
  status: "started" | "completed" | "failed" | "cancelled";
};

const WORK_CONTROL_TOOL_NAMES = new Set([
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
]);

export class GuidedWorkToolResultWriter {
  constructor(private readonly db: Database) {}

  attach(workId: string, input: AttachToolResultInput): string {
    const result = this.db.query<ToolResultRow, [string]>(`
      SELECT turn_id, tool_name, status
      FROM btcc_guided_tool_calls WHERE call_id = ?
    `).get(input.toolCallId);
    if (!result || result.turn_id !== input.turnId || result.status === "started") {
      throw new Error(`Durable Work tool result is not committed: ${input.toolCallId}`);
    }
    if (WORK_CONTROL_TOOL_NAMES.has(result.tool_name)) {
      throw new Error(`Durable Work control result cannot be attached: ${result.tool_name}`);
    }
    const existing = this.db.query<{
      result_ref: string;
      work_id: string;
    }, [string]>(`
      SELECT result_ref, work_id FROM btcc_guided_work_results WHERE tool_call_id = ?
    `).get(input.toolCallId);
    if (existing && existing.work_id !== workId) {
      throw new Error("Durable Work tool result is already bound to another Work");
    }
    const resultRef = existing?.result_ref
      ?? guidedWorkRecordId("result", input.toolCallId);
    if (!existing) {
      this.db.query(`
        INSERT INTO btcc_guided_work_results (
          result_ref, work_id, sequence, tool_call_id, origin_turn_id, attached_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        resultRef,
        workId,
        this.latestSequence(workId) + 1,
        input.toolCallId,
        input.turnId,
        new Date().toISOString(),
      );
    }
    return resultRef;
  }

  private latestSequence(workId: string): number {
    return this.db.query<{ sequence: number }, [string]>(`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM btcc_guided_work_results WHERE work_id = ?
    `).get(workId)?.sequence ?? 0;
  }
}
