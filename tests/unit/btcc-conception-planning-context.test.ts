import { describe, expect, test } from "bun:test";
import { retainConceptionPlanningContext } from
  "../../packages/butler-agent/src/agent/btcc/conception/planning-context.ts";
import type { OperationResultProjection } from
  "../../packages/butler-agent/src/agent/btcc/operation-result/index.ts";

describe("BTCC Conception PlanningContext", () => {
  test("hands stable observations across the semantic phase boundary without payload replay", () => {
    const observed = operationResult("result-source", "read-source", "src/decision/judge.ts");
    const selectedView = operationResult(
      "result-source-view",
      "read-source-view",
      "src/decision/judge.ts",
    );

    const first = retainConceptionPlanningContext([observed]);
    const accepted = retainConceptionPlanningContext([observed, selectedView], first);

    expect(accepted.observationResultIndex).toHaveLength(2);
    expect(accepted.observationResultIndex[0]).toMatchObject({
      resultRef: observed.resultRef,
      readScopeRef: observed.readScopeRef,
      source: {
        kind: "observe",
        capabilityRef: "read_file",
        scopeRef: "workspace:/repo",
        input: { path: "src/decision/judge.ts" },
      },
    });
    expect(JSON.stringify(accepted)).not.toContain(observed.content);
  });
});

function operationResult(
  resultId: string,
  requestId: string,
  path: string,
): OperationResultProjection {
  return {
    resultRef: { id: resultId, sha256: `${resultId}-sha` },
    requestRef: { id: requestId, sha256: `${requestId}-sha` },
    requestId,
    request: {
      kind: "observe",
      requestId,
      capabilityRef: "read_file",
      scopeRef: "workspace:/repo",
      input: { path },
    },
    capabilityRef: "read_file",
    outcome: "observed",
    completeness: "complete",
    byteLength: 4_000,
    observationRef: { id: `${resultId}-observation`, sha256: "observation-sha" },
    preview: "export function judge() {}",
    content: "full source payload that must not cross the phase boundary",
    omittedBytes: 0,
    readScopeRef: `result:${resultId}`,
  };
}
