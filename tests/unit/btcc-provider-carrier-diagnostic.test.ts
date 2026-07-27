import { expect, test } from "bun:test";
import { describeProviderCarrierShape } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/provider-carrier-diagnostic.ts";

test("provider carrier diagnostics retain identifiers without payload values", () => {
  const diagnostic = describeProviderCarrierShape({
    kind: "operation_requests",
    phaseContinuity: { objectiveState: "SECRET_CONTINUITY" },
    requests: [{
      requestId: "read-1",
      kind: "observe",
      capabilityRef: "workspace:read",
      scopeRef: "workspace:project",
      relativeTarget: "src/main.ts",
      publicTitle: "SECRET_TITLE",
      input: { command: "SECRET_COMMAND" },
    }],
  });

  expect(JSON.parse(diagnostic)).toEqual({
    keys: ["kind", "phaseContinuity", "requests"],
    submissionKeys: [],
    requests: [{
      keys: [
        "capabilityRef",
        "input",
        "kind",
        "publicTitle",
        "relativeTarget",
        "requestId",
        "scopeRef",
      ],
      requestId: "read-1",
      kind: "observe",
      capabilityRef: "workspace:read",
      scopeRef: "workspace:project",
      relativeTarget: "src/main.ts",
    }],
  });
  expect(diagnostic).not.toContain("SECRET");
});
