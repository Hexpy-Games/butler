import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  missingReviewCriteria,
  parsePrincipalDecisionCallback,
  plannedInternalGoal,
  plannedModeSafety,
  PlannedTaskStore,
  validatePlannedTaskPlan,
  type PlannedTaskPlan,
} from "../../packages/butler-agent/src/agent/work/planned-task.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-planned-task-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function plan(overrides: Partial<PlannedTaskPlan> = {}): PlannedTaskPlan {
  return {
    task_id: "planned-test-1",
    type: "planned",
    goal: "Implement the feature safely",
    internal_goal: "Complete the feature safely before reporting",
    project: "fixtures/butler-project",
    created_at: "2026-04-25T00:00:00.000Z",
    origin_session_id: "butler/main",
    origin_event_id: "mock:1",
    decision_policy: "autonomous unless critical risk appears",
    acceptance_criteria: [
      "Relevant unit tests pass",
      "Public report includes residual risk",
    ],
    verification_commands: ["bun run check"],
    review_policy: "Reviewer must compare evidence against every criterion.",
    repair_policy: {
      max_attempts: 2,
      allow_autonomous_repair: true,
    },
    public_report_policy: "Report only after review or public failure readiness.",
    ...overrides,
  };
}

test("planned task store creates durable plan state without spawning a worker", () => {
  const store = new PlannedTaskStore(tempDir);
  const record = store.create(plan());

  expect(record.status).toBe("PLANNED");
  expect(plannedInternalGoal(record.plan)).toBe("Complete the feature safely before reporting");
  expect(record.plan.acceptance_criteria).toHaveLength(2);
  expect(record.attempts).toEqual([]);
  expect(record.latestResult).toBeNull();
  expect(readFileSync(join(record.taskDir, "plan.md"), "utf8")).toContain("## Acceptance Criteria");
  expect(readFileSync(join(record.taskDir, "status"), "utf8").trim()).toBe("PLANNED");
});

test("planned task plan rejects empty acceptance criteria", () => {
  expect(() => validatePlannedTaskPlan(plan({ acceptance_criteria: [] })))
    .toThrow("planned task requires non-empty acceptance criteria");
  expect(() => validatePlannedTaskPlan(plan({ acceptance_criteria: ["   "] })))
    .toThrow("planned task requires non-empty acceptance criteria");
  expect(() => validatePlannedTaskPlan(plan({ repair_policy: {
    max_attempts: -1,
    allow_autonomous_repair: true,
  } }))).toThrow("planned task repair max_attempts must be non-negative");
});

test("planned task status transitions are explicit", () => {
  const store = new PlannedTaskStore(tempDir);
  store.create(plan());

  expect(store.transition("planned-test-1", "PLANNED_RUNNING").status).toBe("PLANNED_RUNNING");
  expect(store.transition("planned-test-1", "WORKER_DONE").status).toBe("WORKER_DONE");
  expect(store.transition("planned-test-1", "REVIEWING").status).toBe("REVIEWING");
  expect(store.transition("planned-test-1", "REVIEW_PASSED").status).toBe("REVIEW_PASSED");
  expect(store.transition("planned-test-1", "PUBLIC_REPORT_READY").status).toBe("PUBLIC_REPORT_READY");
  expect(store.transition("planned-test-1", "REPORTED").status).toBe("REPORTED");
});

test("planned task mode safety maps states to reporting guards", () => {
  const store = new PlannedTaskStore(tempDir);
  store.create(plan());

  expect(plannedModeSafety(store.read("planned-test-1")!)).toMatchObject({
    work_mode: "planning",
    safe_to_report: false,
    completion_claim_allowed: false,
  });

  store.transition("planned-test-1", "PLANNED_RUNNING");
  expect(plannedModeSafety(store.read("planned-test-1")!)).toMatchObject({
    work_mode: "executing",
    safe_to_report: false,
    completion_claim_allowed: false,
  });

  store.transition("planned-test-1", "WORKER_DONE");
  expect(plannedModeSafety(store.read("planned-test-1")!)).toMatchObject({
    work_mode: "reviewing",
    safe_to_report: false,
    completion_claim_allowed: false,
  });
});

test("planned review coverage detects missing acceptance criteria", () => {
  const store = new PlannedTaskStore(tempDir);
  const record = store.create(plan());

  expect(missingReviewCriteria(record, [{
    criterion: "Relevant unit tests pass",
    verdict: "PASS",
    evidence: "bun run check passed",
  }])).toEqual(["Public report includes residual risk"]);
  expect(missingReviewCriteria(record, [{
    criterion_index: 2,
    criterion: "Public report covers risks",
    verdict: "PASS",
    evidence: "report includes the residual risk section",
  }])).toEqual(["Relevant unit tests pass"]);
});

test("planned task status rejects invalid transitions", () => {
  const store = new PlannedTaskStore(tempDir);
  store.create(plan());

  expect(() => store.transition("planned-test-1", "REPORTED"))
    .toThrow("invalid planned task transition PLANNED -> REPORTED");
  store.transition("planned-test-1", "PLANNED_RUNNING");
  store.transition("planned-test-1", "WORKER_DONE");
  expect(() => store.transition("planned-test-1", "PUBLIC_REPORT_READY"))
    .toThrow("invalid planned task transition WORKER_DONE -> PUBLIC_REPORT_READY");
  store.transition("planned-test-1", "REVIEWING");
  store.transition("planned-test-1", "REVIEW_PASSED");
  expect(() => store.transition("planned-test-1", "PLANNED_RUNNING"))
    .toThrow("invalid planned task transition REVIEW_PASSED -> PLANNED_RUNNING");
});

test("planned task store writes attempts, reviews, and public reports", () => {
  const store = new PlannedTaskStore(tempDir);
  store.create(plan());
  store.transition("planned-test-1", "PLANNED_RUNNING");
  store.writeAttemptResult("planned-test-1", 1, "Implemented and ran bun run check.");
  store.transition("planned-test-1", "WORKER_DONE");
  store.transition("planned-test-1", "REVIEWING");
  store.writeReview({
    task_id: "planned-test-1",
    attempt: 1,
    verdict: "PASS",
    reviewed_at: "2026-04-25T00:10:00.000Z",
    goal_review: {
      goal: "Complete the feature safely before reporting",
      verdict: "PASS",
      evidence: "feature was implemented and checked",
    },
    criteria: [{
      criterion: "Relevant unit tests pass",
      verdict: "PASS",
      evidence: "bun run check passed",
    }],
    missing_evidence: [],
    repair_recommendation: null,
  });
  store.transition("planned-test-1", "REVIEW_PASSED");
  store.transition("planned-test-1", "PUBLIC_REPORT_READY");
  store.writePublicReport("planned-test-1", "Reviewed and ready to report.");

  const record = store.read("planned-test-1");
  expect(record?.attempts).toEqual(["001"]);
  expect(record?.latestResult).toContain("Implemented");
  expect(record?.review?.verdict).toBe("PASS");
  expect(record?.publicReport).toBe("Reviewed and ready to report.");
  expect(readFileSync(join(record!.taskDir, "review.md"), "utf8")).toContain("PASS: Relevant unit tests pass");
});

test("planned task store records worker dispatch attempts before results exist", () => {
  const store = new PlannedTaskStore(tempDir);
  const record = store.create({
    task_id: "planned-dispatch",
    type: "planned",
    goal: "Run the planned work",
    project: "/tmp/project",
    created_at: "2026-04-25T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["Worker attempt is linked"],
    verification_commands: ["bun test"],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief",
  });

  const updated = store.writeAttemptDispatch(record.taskId, 1, {
    worker_task_id: "worker-1",
    prompt: "Execute from plan.md",
  });

  expect(updated.attempts).toEqual(["001"]);
  expect(updated.latestResult).toBeNull();
  expect(readFileSync(join(updated.taskDir, "attempts", "001", "worker-task-id"), "utf8").trim()).toBe("worker-1");
  expect(readFileSync(join(updated.taskDir, "attempts", "001", "prompt.md"), "utf8")).toContain("Execute from plan.md");
});

test("planned task store records and answers principal decisions", () => {
  const store = new PlannedTaskStore(tempDir);
  const record = store.create(plan({ task_id: "planned-decision" }));
  store.writeDecision(record.taskId, {
    decision_id: "dec-1",
    task_id: record.taskId,
    situation: "External cost is required.",
    recommended_option_id: "approve",
    options: [
      { id: "approve", label: "Approve", description: "Proceed with the paid option." },
      { id: "skip", label: "Skip", description: "Avoid the cost." },
    ],
    tradeoffs: ["Approve is faster; skip is cheaper."],
    expires_at: null,
    created_at: "2026-04-25T00:00:00.000Z",
    response: null,
  });

  expect(parsePrincipalDecisionCallback("pd:dec-1:approve")).toEqual({
    decisionId: "dec-1",
    optionId: "approve",
  });
  expect(parsePrincipalDecisionCallback("other:dec-1:approve")).toBeNull();

  const answered = store.answerDecision({
    decisionId: "dec-1",
    optionId: "approve",
    transport: "app",
    actorId: "user-1",
  });
  expect(answered.decision?.response).toMatchObject({
    option_id: "approve",
    transport: "app",
    actor_id: "user-1",
  });
});

test("planned task summaries expose safe planned state", () => {
  const store = new PlannedTaskStore(tempDir);
  store.create(plan());
  store.transition("planned-test-1", "PLANNED_RUNNING");
  store.writeAttemptResult("planned-test-1", 1, "Partial implementation.");
  store.transition("planned-test-1", "WORKER_DONE");
  store.transition("planned-test-1", "REVIEWING");
  store.writeReview({
    task_id: "planned-test-1",
    attempt: 1,
    verdict: "FAIL",
    reviewed_at: "2026-04-25T00:10:00.000Z",
    goal_review: {
      goal: "Complete the feature safely before reporting",
      verdict: "FAIL",
      evidence: "verification output is missing",
    },
    criteria: [{
      criterion: "Relevant unit tests pass",
      verdict: "FAIL",
      evidence: "No test output was present.",
    }],
    missing_evidence: ["verification output"],
    repair_recommendation: "Run tests and attach output.",
  });
  store.transition("planned-test-1", "REVIEW_FAILED");
  store.transition("planned-test-1", "FAILED_PUBLIC_REPORT_READY");
  store.writePublicReport("planned-test-1", "Could not verify safely.");

  expect(store.summaries(5)).toEqual([{
    task_id: "planned-test-1",
    status: "FAILED_PUBLIC_REPORT_READY",
    goal: "Implement the feature safely",
    project: "fixtures/butler-project",
    review_verdict: "FAIL",
    public_report_ready: true,
    attempts: 1,
  }]);
});
