import { expect, test } from "bun:test";
import { bindFunctionArguments } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/provider-phase-prompt-runner.ts";
import { providerCarrierFunctions } from
  "../../packages/butler-agent/src/agent/btcc/infrastructure/model/provider-carrier-schema.ts";
import { taskReviewSubmissionSchema } from
  "../../packages/butler-agent/src/agent/btcc/review/submission-schema.ts";

test("function-tool phase carrier fields bind without an alternate flat shape", () => {
  const publicActivity = {
    summary: "계획을 작성했습니다.",
    rationale: "목표와 스펙을 반영했습니다.",
    nextStep: "계획 검토로 이동합니다.",
  };
  expect(bindFunctionArguments({
    name: "submit_btcc_phase_plan_candidate_1",
    description: "Submit a Plan.",
    carrierKind: "phase_submission",
    parameters: {},
  }, {
    submission: {
      kind: "plan_candidate",
      strategy: "Deliver the smallest sufficient change.",
      works: [],
    },
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

test("task-review function exposes and binds the exact explicit submission carrier", () => {
  const submissionSchema = taskReviewSubmissionSchema("semantic");
  const [definition] = providerCarrierFunctions([], submissionSchema);
  expect(definition?.parameters).toEqual({
    type: "object",
    properties: {
      submission: submissionSchema,
      publicActivity: expect.any(Object),
    },
    required: ["submission", "publicActivity"],
    additionalProperties: false,
  });
  const submission = {
    kind: "task_review",
    criterionVerdicts: [],
    findings: [],
  };
  const publicActivity = {
    summary: "검토했습니다.",
    rationale: "현재 결과를 기준과 비교했습니다.",
    nextStep: "검토 결과를 반영합니다.",
  };
  expect(bindFunctionArguments(definition!, { submission, publicActivity })).toEqual({
    kind: "phase_submission",
    submission,
    publicActivity,
  });
});

test("flat phase arguments are not heuristically converted into a submission", () => {
  expect(bindFunctionArguments({
    name: "submit_btcc_phase_task_review_1",
    description: "Submit a Task Review.",
    carrierKind: "phase_submission",
    parameters: {},
  }, {
    kind: "task_review",
    criterionVerdicts: [],
    findings: [],
  })).toEqual({
    kind: "phase_submission",
    criterionVerdicts: [],
    findings: [],
  });
});
