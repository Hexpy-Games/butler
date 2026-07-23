import { expect, test } from "bun:test";
import { decodeTaskImpact } from
  "../../packages/butler-agent/src/agent/btcc/planning/decode-task-impact.ts";
import type { ManagedTask } from
  "../../packages/butler-agent/src/agent/btcc/planning/contracts.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

test("governing rework may replace a Task logical identity", () => {
  const prior = task("persist-relationship", "prior");
  const replacement = task("store-relationship-events", "replacement");

  expect(decodeTaskImpact({
    submission: [{
      priorTaskLogicalId: prior.taskLogicalId,
      disposition: "rework",
      successorTaskLogicalId: replacement.taskLogicalId,
      reason: "The reviewed responsibility moved to an atomic event store.",
    }],
    currentTasks: [{ task: prior, status: "review_failed" }],
    nextTasks: [replacement],
  })).toEqual([{
    priorTaskRef: prior.ref,
    disposition: "rework",
    reason: "The reviewed responsibility moved to an atomic event store.",
    successorTaskRef: replacement.ref,
  }]);
});

test("replan may retire a prior Task while newly required Tasks start fresh", () => {
  const prior = task("broad-relationship-task", "prior");

  expect(decodeTaskImpact({
    submission: [{
      priorTaskLogicalId: prior.taskLogicalId,
      disposition: "replan",
      reason: "The broad responsibility was decomposed.",
    }],
    currentTasks: [{ task: prior, status: "review_failed" }],
    nextTasks: [
      task("relationship-event-store", "store"),
      task("relationship-profile-projection", "projection"),
    ],
  })).toEqual([{
    priorTaskRef: prior.ref,
    disposition: "replan",
    reason: "The broad responsibility was decomposed.",
  }]);
});

test("unaffected lineage cannot silently change Task identity", () => {
  const prior = task("stable-task", "stable");
  const replacement = task("different-task", "different");

  expect(() => decodeTaskImpact({
    submission: [{
      priorTaskLogicalId: prior.taskLogicalId,
      disposition: "unaffected",
      successorTaskLogicalId: replacement.taskLogicalId,
      reason: "Claimed unchanged.",
    }],
    currentTasks: [{ task: prior, status: "accepted", currentResult: {} }],
    nextTasks: [replacement],
  })).toThrow("unaffected impact must preserve Task logical identity");
});

function task(logicalId: string, revision: string): ManagedTask {
  return {
    ref: ref(revision),
    taskLogicalId: logicalId,
  } as ManagedTask;
}
