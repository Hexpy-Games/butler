import { describe, expect, test } from "bun:test";
import { projectOperationContext } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/project-operation-context.ts";
import type {
  OperationResultProjection,
  PhaseEnvelope,
} from "../../packages/butler-agent/src/agent/btcc/index.ts";

describe("BTCC operation context projection", () => {
  test("selects the exact last batch when result reads share their source ref", () => {
    const source = result("source-read", "read_file");
    const previousRead = result("first-result-read", "read_operation_result", source);
    const latestRead = result("second-result-read", "read_operation_result", source);
    const envelope = {
      operationResults: [source, previousRead, latestRead],
      latestOperationResultCount: 1,
    } as PhaseEnvelope;

    expect(projectOperationContext(envelope)).toEqual({
      phaseContinuity: null,
      latestOperationResults: [latestRead],
      priorOperationResultIndex: [
        expect.objectContaining({
          resultRef: source.resultRef,
          capabilityRef: "read_file",
        }),
      ],
    });
  });
});

function result(
  requestId: string,
  capabilityRef: string,
  source?: OperationResultProjection,
): OperationResultProjection {
  const resultRef = source?.resultRef ?? ref("result-source");
  return {
    resultRef,
    requestRef: source?.requestRef ?? ref(`request-${requestId}`),
    requestId,
    request: {
      requestId,
      kind: "observe",
      capabilityRef,
      scopeRef: "workspace:/repo",
      input: {},
    },
    capabilityRef,
    outcome: "observed",
    completeness: "complete",
    byteLength: 1_000,
    observationRef: ref("observation-source"),
    preview: capabilityRef === "read_file" ? "source preview" : "",
    omittedBytes: 0,
    readScopeRef: "result:result-source:result-source-sha",
  };
}

function ref(id: string) {
  return { id, sha256: `${id}-sha` };
}
