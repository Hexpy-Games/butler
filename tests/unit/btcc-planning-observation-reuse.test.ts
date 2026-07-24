import { describe, expect, test } from "bun:test";
import {
  admitPlanningObservations,
  retainPlanningObservations,
} from "../../packages/butler-agent/src/agent/btcc/planning/observation-result-index.ts";
import type { PhaseInvocation } from
  "../../packages/butler-agent/src/agent/btcc/core/index.ts";

const original = observation("source-read", "read_file");

describe("BTCC Planning observation reuse", () => {
  test("retains the original observation when an exact read shares its result ref", () => {
    const exactRead = {
      ...observation("range-read", "read_operation_result"),
      resultRef: original.resultRef,
      readScopeRef: original.readScopeRef,
    };

    expect(retainPlanningObservations([original], [exactRead]))
      .toEqual([original]);
  });

  test("admits retained result scopes without duplicating existing authority", () => {
    const phase = {
      operationAuthority: {
        observationScopeRefs: ["workspace:/repo", original.readScopeRef],
        mutation: { kind: "forbidden" as const },
      },
    } as PhaseInvocation;

    expect(admitPlanningObservations(phase, [original]).operationAuthority)
      .toEqual({
        observationScopeRefs: ["workspace:/repo", original.readScopeRef],
        mutation: { kind: "forbidden" },
      });
  });
});

function observation(requestId: string, capabilityRef: string) {
  return {
    resultRef: ref("result-source"),
    requestRef: ref(`request-${requestId}`),
    requestId,
    request: {
      requestId,
      kind: "observe" as const,
      capabilityRef,
      scopeRef: "workspace:/repo/source.ts",
      input: {},
    },
    capabilityRef,
    outcome: "observed" as const,
    completeness: "complete" as const,
    byteLength: 12_000,
    observationRef: ref("observation-source"),
    preview: "",
    omittedBytes: 12_000,
    readScopeRef: "result:result-source:result-source-sha",
  };
}

function ref(id: string) {
  return { id, sha256: `${id}-sha` };
}
