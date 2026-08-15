import type { Database } from "bun:sqlite";
import type {
  ContinueWorkCommand,
  ReplaceWorkPlanCommand,
  StartWorkCommand,
} from "../../../btcc/work/index.ts";
import { GuidedWorkToolResultWriter } from "./guided-work-tool-result-writer.ts";
import { GuidedWorkViewReader } from "./guided-work-view-reader.ts";

/** Atomic current-Turn result attachment shared by relation operations. */
export class GuidedWorkRelationBackfill {
  constructor(
    private readonly db: Database,
    private readonly reader: GuidedWorkViewReader,
    private readonly toolResults: GuidedWorkToolResultWriter,
  ) {}

  attach(
    workId: string,
    input: Pick<
      StartWorkCommand | ContinueWorkCommand | ReplaceWorkPlanCommand,
      "turnId" | "sessionId" | "projectRef" | "mutationCallId" | "backfillToolCallIds"
    >,
  ): void {
    const toolCallIds = input.backfillToolCallIds ?? [];
    if (toolCallIds.length === 0) return;
    this.reader.relationTurn(input);
    for (const toolCallId of toolCallIds) {
      this.toolResults.attach(workId, {
        turnId: input.turnId,
        sessionId: input.sessionId,
        ...(input.projectRef ? { projectRef: input.projectRef } : {}),
        mutationCallId: `${input.mutationCallId}:backfill:${toolCallId}`,
        toolCallId,
      });
    }
  }
}
