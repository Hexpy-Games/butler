import { expect, test } from "bun:test";
import { bindFunctionArguments } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/provider-phase-prompt-runner.ts";

test("function-tool phase arguments become one internal phase carrier", () => {
  const publicActivity = {
    summary: "계획을 작성했습니다.",
    rationale: "목표와 스펙을 반영했습니다.",
    nextStep: "계획 검토로 이동합니다.",
  };
  expect(bindFunctionArguments({
    name: "submit_btcc_phase_plan_candidate_1",
    description: "Submit a Plan.",
    carrierKind: "phase_submission",
    argumentBinding: "flat_phase_submission",
    parameters: {},
  }, {
    kind: "plan_candidate",
    strategy: "Deliver the smallest sufficient change.",
    works: [],
    publicActivity,
  })).toEqual({
    kind: "phase_submission",
    submission: {
      kind: "plan_candidate",
      strategy: "Deliver the smallest sufficient change.",
      works: [],
    },
    publicActivity,
  });
});

test("function-tool operation arguments retain carrier fields", () => {
  expect(bindFunctionArguments({
    name: "submit_btcc_operation_requests",
    description: "Request operations.",
    carrierKind: "operation_requests",
    argumentBinding: "carrier_fields",
    parameters: {},
  }, {
    phaseContinuity: { objectiveState: "inspect" },
    requests: [{ requestId: "read-1" }],
  })).toEqual({
    kind: "operation_requests",
    phaseContinuity: { objectiveState: "inspect" },
    requests: [{ requestId: "read-1" }],
  });
});
