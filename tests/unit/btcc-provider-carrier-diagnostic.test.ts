import { expect, test } from "bun:test";
import { acceptProviderCarrier, describeProviderCarrierShape } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/provider-carrier-protocol.ts";
import { providerCarrierSchema } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/provider-carrier-schema.ts";

const activity = {
  title: "계획 수정",
  summary: "영향받은 작업의 계획을 수정했습니다.",
  rationale: "검토 결과를 반영하기 위해 필요합니다.",
  nextStep: "수정된 계획을 검토합니다.",
};

test("canonicalizes phase activity misplaced inside a function submission", () => {
  const schema = providerCarrierSchema([], {
    type: "object",
    properties: { kind: { type: "string", const: "plan" } },
    required: ["kind"],
    additionalProperties: false,
  });
  const accepted = acceptProviderCarrier({
    kind: "phase_submission",
    submission: { kind: "plan", publicActivity: activity },
  }, {
    responseSchema: schema,
    authority: { observationScopeRefs: [], mutation: { kind: "forbidden" } },
    actualIdentity: {
      provider: "zai",
      model: "glm-5.2",
      reasoningEffort: "medium",
      controlsHash: "controls",
    },
  });

  expect(accepted).toMatchObject({
    kind: "phase_submission",
    submission: { kind: "plan" },
    publicActivity: activity,
  });
});

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
