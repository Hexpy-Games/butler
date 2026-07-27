import { expect, test } from "bun:test";
import { describeProviderCarrierShape } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/provider-carrier-protocol.ts";

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

  expect(diagnostic).toEqual({
    carrierType: "object",
    carrierKeys: ["kind", "phaseContinuity", "requests"],
    submissionKeys: [],
    requestsType: "array",
    requestCount: 1,
    requestKeys: [[
        "capabilityRef",
        "input",
        "kind",
        "publicTitle",
        "relativeTarget",
        "requestId",
        "scopeRef",
      ]],
  });
  expect(JSON.stringify(diagnostic)).not.toContain("SECRET");
  expect(JSON.stringify(diagnostic)).not.toContain("src/main.ts");
});
