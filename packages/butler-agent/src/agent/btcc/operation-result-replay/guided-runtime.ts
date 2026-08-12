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
  journal: GuidedToolJournal;
  exactReader?: GuidedOperationResultReader;
  sessionId: string;
  projectRef?: string;
}): GuidedOperationResultRuntime {
  if (input.mode === "disabled") {
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
    sessionId: input.sessionId,
    projectRef: input.projectRef,
  });
  if (!input.exactReadCapability) {
    throw new Error("operation_result_exact_read_dependency_missing");
  }
  return {
    replay,
    read: (args) => replay.readExact(exactReadArguments(args)),
  };
}
