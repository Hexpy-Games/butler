import type { Database } from "bun:sqlite";
import type { AttachToolResultInput } from "../../../btcc/work/index.ts";
import { guidedWorkRecordId } from "./guided-work-record-id.ts";

type ToolResultRow = {
  turn_id: string;
  tool_name: string;
  status: "started" | "completed" | "failed" | "cancelled";
  source_turn_rowid: number | null;
  source_turn_sequence: number | null;
};

const WORK_CONTROL_TOOL_NAMES = new Set([
  "start_work",
  "continue_work",
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
]);

export class GuidedWorkToolResultWriter {
  constructor(private readonly db: Database) {}

  attach(workId: string, input: AttachToolResultInput): string {
    const result = this.db.query<ToolResultRow, [string]>(`
      SELECT call.turn_id, call.tool_name, call.status,
        turn.rowid AS source_turn_rowid,
        call.turn_sequence AS source_turn_sequence
      FROM btcc_guided_tool_calls call
      LEFT JOIN btcc_turns turn ON turn.turn_id = call.turn_id
      WHERE call.call_id = ?
    `).get(input.toolCallId);
    if (!result || result.turn_id !== input.turnId || result.status === "started") {
      throw new Error(`Durable Work tool result is not committed: ${input.toolCallId}`);
    }
    if (result.status !== "completed") {
      throw new Error(
        `Durable Work tool result is not eligible for attachment: ${input.toolCallId}`,
      );
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
          result_ref, work_id, sequence, tool_call_id, origin_turn_id,
          source_turn_rowid, source_turn_sequence, attached_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resultRef,
        workId,
        this.latestSequence(workId) + 1,
        input.toolCallId,
        input.turnId,
        result.source_turn_rowid,
        result.source_turn_sequence,
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
