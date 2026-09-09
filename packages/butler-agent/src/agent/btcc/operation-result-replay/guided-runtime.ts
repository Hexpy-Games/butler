import type {
  GuidedOperationResultReader,
  GuidedToolJournal,
} from "../ports/index.ts";
import {
  createOperationResultReplay,
  exactReadArguments,
  type OperationResultReplay,
} from "./operation-result-replay.ts";

export type GuidedOperationResultRuntime = {
  replay?: OperationResultReplay;
  read?: (args: Record<string, unknown>) => unknown;
};

export function createGuidedOperationResultRuntime(input: {
  mode: "disabled" | "available";
  exactReadCapability: boolean;
  turnId: string;
  turnRevision: number;
  workId?: string;
  journal: GuidedToolJournal;
  exactReader?: GuidedOperationResultReader;
  sessionId: string;
  projectRef?: string;
}): GuidedOperationResultRuntime {
  if (input.mode === "disabled" && !input.exactReadCapability) {
    return {};
  }
  if (!input.exactReader) {
    throw new Error("operation_result_replay_dependency_missing");
  }
  const replay = createOperationResultReplay({
    turnId: input.turnId,
    turnRevision: input.turnRevision,
    journal: input.journal,
    exactReader: input.exactReader,
    exactReadCapability: input.exactReadCapability,
    replaceDeliveredResults: input.mode === "available",
    sessionId: input.sessionId,
    projectRef: input.projectRef,
  });
  if (!input.exactReadCapability) {
    throw new Error("operation_result_exact_read_dependency_missing");
  }
  return {
    replay,
    read: (args) => {
      if (args.__list !== true) return replay.readExact(exactReadArguments(args));
      if (!input.exactReader!.discover) throw new Error("operation_history_reader_missing");
      const page = input.exactReader!.discover({
        turnId: input.turnId, cursor: Number(args.cursor ?? 0),
        workId: input.workId,
        ...(args.through == null ? {} : { through: Number(args.through) }),
        query: typeof args.query === "string" ? args.query : "",
        toolName: typeof args.tool_name === "string" ? args.tool_name : undefined,
        status: typeof args.status === "string" ? args.status : undefined,
        limit: Math.min(10, Math.max(1, Number(args.limit ?? 5))),
      });
      return { through: page.through, next_cursor: page.nextCursor, entries: page.entries.map((entry) => {
        const reference = input.exactReader!.resolveResultReference({ turnId: entry.originTurnId ?? input.turnId, callId: entry.callId });
        return { tool_name: entry.toolName, status: entry.status, started_at: entry.startedAt,
          request_preview: entry.requestPreview, exact_read: {
            result_ref: reference.resultRef, sha256: entry.resultSha256, revision: reference.revision,
            work_id: reference.workId ?? null, offset: 0, length: 4096,
          } };
      }) };
    },
  };
}
