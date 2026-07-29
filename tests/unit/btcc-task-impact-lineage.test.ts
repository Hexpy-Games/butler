import { expect, test } from "bun:test";
import { decodeTaskImpact } from "../../packages/butler-agent/src/agent/btcc/planning/decode-task-impact.ts";
import type { ManagedTask } from "../../packages/butler-agent/src/agent/btcc/planning/contracts.ts";
import { feedbackPlanSubmissionSchema } from "../../packages/butler-agent/src/agent/btcc/planning/submission-schemas.ts";

const ref = (id: string) => ({ id, sha256: `${id}-sha` });

test("governing rework may replace a Task logical identity", () => {
  const prior = task("persist-relationship", "prior");
  const replacement = task("store-relationship-events", "replacement");

  expect(
    decodeTaskImpact({
      submission: [
        {
          priorTaskLogicalId: prior.taskLogicalId,
          disposition: "rework",
          successorTaskLogicalId: replacement.taskLogicalId,
          reason: "The reviewed responsibility moved to an atomic event store.",
        },
      ],
      currentTasks: [
        { task: prior, status: "review_failed", hasCurrentResult: false },
      ],
      nextTasks: [replacement],
    }),
  ).toEqual([
    {
      priorTaskRef: prior.ref,
      disposition: "rework",
      reason: "The reviewed responsibility moved to an atomic event store.",
      successorTaskRef: replacement.ref,
    },
  ]);
});

test("replan may retire a prior Task while newly required Tasks start fresh", () => {
  const prior = task("broad-relationship-task", "prior");

  expect(
    decodeTaskImpact({
      submission: [
        {
          priorTaskLogicalId: prior.taskLogicalId,
          disposition: "replan",
          reason: "The broad responsibility was decomposed.",
        },
      ],
      currentTasks: [
        { task: prior, status: "review_failed", hasCurrentResult: false },
      ],
      nextTasks: [
        task("relationship-event-store", "store"),
        task("relationship-profile-projection", "projection"),
      ],
    }),
  ).toEqual([
    {
      priorTaskRef: prior.ref,
      disposition: "replan",
      reason: "The broad responsibility was decomposed.",
    },
  ]);
});

test("unaffected lineage cannot silently change Task identity", () => {
  const prior = task("stable-task", "stable");
  const replacement = task("different-task", "different");

  expect(() =>
    decodeTaskImpact({
      submission: [
        {
          priorTaskLogicalId: prior.taskLogicalId,
          disposition: "unaffected",
          successorTaskLogicalId: replacement.taskLogicalId,
          reason: "Claimed unchanged.",
        },
      ],
      currentTasks: [
        { task: prior, status: "accepted", hasCurrentResult: true },
      ],
      nextTasks: [replacement],
    }),
  ).toThrow("unaffected impact must preserve Task logical identity");
});

test("revalidate preserves logical identity while accepting a newer Task revision", () => {
  const prior = task("stable-task", "prior-revision");
  const revised = task("stable-task", "revised-revision");

  expect(
    decodeTaskImpact({
      submission: [
        {
          priorTaskLogicalId: prior.taskLogicalId,
          disposition: "revalidate",
          successorTaskLogicalId: revised.taskLogicalId,
          revalidationPrerequisiteTaskLogicalIds: [],
          reason:
            "The governing revision requires the accepted result to be revalidated.",
        },
      ],
      currentTasks: [
        { task: prior, status: "accepted", hasCurrentResult: true },
      ],
      nextTasks: [revised],
    })[0]?.successorTaskRef,
  ).toEqual(revised.ref);
});

test("revalidate rejects a changed Task without an accepted concrete result", () => {
  const prior = task("review-failed-task", "prior-revision");
  const revised = task("review-failed-task", "revised-revision");

  expect(() => decodeTaskImpact({
    submission: [{
      priorTaskLogicalId: prior.taskLogicalId,
      disposition: "revalidate",
      successorTaskLogicalId: revised.taskLogicalId,
      revalidationPrerequisiteTaskLogicalIds: [],
      reason: "The contract changed.",
    }],
    currentTasks: [{ task: prior, status: "review_failed", hasCurrentResult: true }],
    nextTasks: [revised],
  })).toThrow(
    "Task review-failed-task has status review_failed and currentResult=true; " +
    "revalidate requires an accepted concrete result, so classify this changed Task " +
    "as rework or replan",
  );
});

test("after-repair revalidation requires an earlier declared Task dependency", () => {
  const prior = task("stable-task", "prior-revision");
  const repair = {
    ...task("repair-task", "repair-revision"),
    executionOrdinal: 2,
    dependencyTaskRefs: [],
  } as ManagedTask;
  const revised = {
    ...task("stable-task", "revised-revision"),
    executionOrdinal: 3,
    dependencyTaskRefs: [repair.ref],
  } as ManagedTask;

  expect(decodeTaskImpact({
    submission: [{
      priorTaskLogicalId: prior.taskLogicalId,
      disposition: "revalidate",
      successorTaskLogicalId: revised.taskLogicalId,
      revalidationPrerequisiteTaskLogicalIds: [repair.taskLogicalId],
      reason: "Review the accepted result only after the repair is complete.",
    }],
    currentTasks: [{ task: prior, status: "accepted", hasCurrentResult: true }],
    nextTasks: [repair, revised],
  })[0]).toMatchObject({
    disposition: "revalidate",
    revalidationPrerequisiteTaskRefs: [repair.ref],
  });
});

test("unaffected lineage preserves the exact Task revision", () => {
  const prior = task("stable-task", "prior-revision");
  const revised = task("stable-task", "revised-revision");

  expect(() =>
    decodeTaskImpact({
      submission: [
        {
          priorTaskLogicalId: prior.taskLogicalId,
          disposition: "unaffected",
          successorTaskLogicalId: revised.taskLogicalId,
          reason: "Claimed unchanged despite a replacement revision.",
        },
      ],
      currentTasks: [
        { task: prior, status: "accepted", hasCurrentResult: true },
      ],
      nextTasks: [revised],
    }),
  ).toThrow(
    "unaffected impact for Task stable-task cannot change the Task revision; " +
    "preserve the exact accepted Task or classify it as revalidate, rework, or replan",
  );
});

test("impact schema requires successors except when replanning", () => {
  const schema = feedbackPlanSubmissionSchema([], "governing_revision", [], 4) as any;
  const variants = schema.properties.impactMap.items.anyOf;

  expect(schema.properties.impactMap.minItems).toBe(4);
  expect(schema.properties.impactMap.maxItems).toBe(4);

  expect(variants[0].properties.disposition).toEqual({
    type: "string",
    const: "replan",
  });
  expect(variants[0].properties).not.toHaveProperty("successorTaskLogicalId");
  expect(variants[1].properties.disposition).toEqual({
    type: "string",
    enum: ["unaffected", "rework"],
  });
  expect(variants[1].required).toContain("successorTaskLogicalId");
  expect(variants[2].properties.disposition).toEqual({
    type: "string",
    const: "revalidate",
  });
  expect(variants[2].required).toContain("revalidationPrerequisiteTaskLogicalIds");
});

function task(logicalId: string, revision: string): ManagedTask {
  return {
    ref: ref(revision),
    taskLogicalId: logicalId,
    executionOrdinal: 1,
    dependencyTaskRefs: [],
  } as unknown as ManagedTask;
}
