import { expect, test } from "bun:test";
import {
  mergeCompactReplayWorkStates,
  projectCompactReplayWorkState,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/compact-replay-work-state.ts";
import type { DurableWorkView } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";

test("T3 mechanical Work state bounds ordinals with explicit recovery metadata", () => {
  const semanticMarker = "PRIVATE_SEMANTIC_WORK_TEXT_must_not_replay";
  const privateActionKey = "PRIVATE_ACTION_KEY_must_not_replay";
  const actionKeys = Array.from(
    { length: 30 },
    (_, index) => index === 0
      ? privateActionKey
      : `action-${String(index).padStart(2, "0")}`,
  );
  const work = workFixture(actionKeys, semanticMarker);
  const state = projectCompactReplayWorkState(work, {
    actionStates: exactIdentity("work-result"),
    reviewCorrection: exactIdentity("review-result"),
  });

  expect(Object.keys(state)).toEqual([
    "work_id",
    "status",
    "stage",
    "allowed_next_stages",
    "revisions",
    "action_states",
    "actions",
    "review_correction",
    "result_refs",
  ]);
  expect(state).toMatchObject({
    status: "open",
    stage: "validation",
    revisions: {
      plan: 7,
      checkpoint: 11,
      plan_review: 12,
      result_review: 13,
      completion_validation: 14,
    },
    action_states: {
      pending: 28,
      active: 0,
      done: 1,
      blocked: 1,
      skipped: 0,
    },
    actions: {
      total: 30,
      represented: 24,
      omitted: 6,
      unresolved_total: 29,
      unresolved_represented: 24,
      unresolved_omitted: 5,
      action_key_recovery: {
        kind: "exact_operation_request",
        pointer: "/result/work/actions",
      },
    },
    review_correction: {
      count: 1,
      review_revision: 14,
      recovery: {
        kind: "exact_operation_request",
        pointer: "/request/corrections",
      },
    },
    result_refs: { total: 40, represented: 16, omitted: 24 },
  });
  expect(state.actions.rows[0]).toEqual({
    plan_ordinal: 2,
    status: "blocked",
  });
  expect(state.actions.rows.at(-1)).toEqual({
    plan_ordinal: 25,
    status: "pending",
  });
  expect(state.actions.rows.some((action) => action.status === "done")).toBe(false);
  expect(state.result_refs.latest[0]).toEqual({
    result_ref: "guided-result-24",
    revision: 25,
    status: "completed",
  });
  expect(state.result_refs.latest.at(-1)?.result_ref).toBe("guided-result-39");
  expect(JSON.stringify(state)).not.toContain(semanticMarker);
  expect(JSON.stringify(state)).not.toContain(privateActionKey);
  expect(JSON.stringify(state)).not.toContain("verdict");
});

test("T3 Work counts use the full current Plan during partial hydration", () => {
  const marker = "PRIVATE_PARTIAL_LEGACY_ACTION_must_not_replay";
  const work = workFixture([marker, "second", "third"], "PRIVATE_DESCRIPTION");
  work.actionProgress = [
    { actionKey: marker, status: "done" },
    { actionKey: "stale-legacy-row", status: "blocked" },
  ];
  work.latestPlanReview = undefined;
  work.latestResultReview = undefined;
  work.latestCompletionValidation = undefined;
  work.resultRefs = [];

  const state = projectCompactReplayWorkState(work);

  expect(state.action_states).toEqual({
    pending: 2,
    active: 0,
    done: 1,
    blocked: 0,
    skipped: 0,
  });
  expect(state.actions).toMatchObject({
    total: 3,
    represented: 3,
    omitted: 0,
    unresolved_total: 2,
    unresolved_represented: 2,
    unresolved_omitted: 0,
    action_key_recovery: { kind: "initial_authoritative_work" },
  });
  expect(state.actions.rows).toEqual([
    { plan_ordinal: 2, status: "pending" },
    { plan_ordinal: 3, status: "pending" },
    { plan_ordinal: 1, status: "done" },
  ]);
  expect(JSON.stringify(state)).not.toContain(marker);
  expect(JSON.stringify(state)).not.toContain("stale-legacy-row");
});

test("T3 latest Work state retains exact recovery from its matching revision", () => {
  const work = workFixture(["private-action"], "private-correction");
  const exact = projectCompactReplayWorkState(work, {
    actionStates: exactIdentity("work-result"),
    reviewCorrection: exactIdentity("review-result"),
  });
  const laterCheckpoint = projectCompactReplayWorkState(work);

  const merged = mergeCompactReplayWorkStates([exact, laterCheckpoint]);

  expect(merged?.actions.action_key_recovery).toMatchObject({
    kind: "exact_operation_request",
    identity: { result_ref: "work-result" },
  });
  expect(merged?.review_correction?.recovery).toMatchObject({
    kind: "exact_operation_request",
    identity: { result_ref: "review-result" },
  });
});

function exactIdentity(resultRef: string) {
  return {
    kind: "direct" as const,
    result_ref: resultRef,
    revision: null,
    result_sha256: "a".repeat(64),
  };
}

function workFixture(
  actionKeys: string[],
  semanticMarker: string,
): DurableWorkView {
  return {
    workId: "guided-work-bounded-state",
    sessionId: "session-bounded-state",
    scope: { kind: "session", sessionId: "session-bounded-state" },
    origin: { turnId: "turn-bounded-state", messageId: "message-bounded-state" },
    objective: semanticMarker,
    status: "open",
    currentStage: "validation",
    allowedNextStages: ["planning", "execution", "review", "reporting"],
    actionProgress: actionKeys.map((actionKey, index) => ({
      actionKey,
      status: index === 0 ? "done" as const
        : index === 1 ? "blocked" as const : "pending" as const,
      ...(index === 0 ? { note: semanticMarker } : {}),
    })),
    currentPlan: {
      planRevisionId: "plan-revision-bounded-state",
      revision: 7,
      objective: semanticMarker,
      actions: actionKeys.map((actionKey) => ({
        actionKey,
        description: semanticMarker,
        dependencyKeys: [],
      })),
      checks: [semanticMarker],
      originTurnId: "turn-bounded-state",
      createdAt: "2026-08-11T00:00:00.000Z",
    },
    latestCheckpoint: {
      checkpointRevisionId: "checkpoint-revision-bounded-state",
      revision: 11,
      planRevisionId: "plan-revision-bounded-state",
      stage: "validation",
      actionProgress: [],
      publicSummary: semanticMarker,
      nextStep: semanticMarker,
      referencedResultRefs: [],
      originTurnId: "turn-bounded-state",
      createdAt: "2026-08-11T00:00:00.000Z",
    },
    latestPlanReview: review(12, "plan", semanticMarker),
    latestResultReview: review(13, "result", semanticMarker),
    latestCompletionValidation: review(14, "completion", semanticMarker),
    resultRefs: Array.from({ length: 40 }, (_, index) => ({
      resultRef: `guided-result-${String(index).padStart(2, "0")}`,
      sequence: index + 1,
      toolCallId: `call-${index}`,
      toolName: "read_file",
      status: "completed" as const,
      originTurnId: "turn-bounded-state",
      attachedAt: "2026-08-11T00:00:00.000Z",
    })),
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function review(
  revision: number,
  subject: "plan" | "result" | "completion",
  semanticMarker: string,
): NonNullable<DurableWorkView["latestPlanReview"]> {
  return {
    reviewRevisionId: `review-revision-${revision}`,
    revision,
    subject,
    verdict: "accept",
    summary: semanticMarker,
    corrections: [semanticMarker],
    boundResultRefs: [],
    originTurnId: "turn-bounded-state",
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}
