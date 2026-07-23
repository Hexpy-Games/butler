import {
  ref,
  type OperationResultProjection,
} from "../../../agent/btcc/operation-result/index.ts";
import { SqliteOperationResultStore } from
  "../../../agent/btcc/infrastructure/operation-result/index.ts";

export function archiveWakeResult(input: {
  butlerData: string;
  sourceTurnId: string;
  triggerId: string;
  capabilityRef: string;
  sourceScopeRef: string;
  content: string;
  contextWindowTokens: number;
}): OperationResultProjection {
  const store = new SqliteOperationResultStore(input.butlerData);
  const request = {
    requestId: input.triggerId,
    kind: "observe" as const,
    capabilityRef: input.capabilityRef,
    scopeRef: input.sourceScopeRef,
    input: {},
  };
  try {
    return store.recordExternal({
      sourceTurnId: input.sourceTurnId,
      triggerId: input.triggerId,
      request,
      result: {
        requestId: request.requestId,
        outcome: "observed",
        observationRef: ref("external-operation-observation", input.content),
        content: input.content,
        completeness: "complete",
      },
      modelSelection: {
        provider: "gateway",
        model: "wake-projection",
        reasoningEffort: "none",
        controls: {},
        controlsHash: "wake-projection",
        contextWindowTokens: input.contextWindowTokens,
      },
    });
  } finally {
    store.close();
  }
}

export function renderWakeResult(
  result: OperationResultProjection,
): string {
  const omission = result.omittedBytes > 0
    ? `\n[${result.omittedBytes} bytes omitted from this projection; read ${result.readScopeRef} for an exact range.]`
    : "";
  return `${result.preview}${omission}`;
}
