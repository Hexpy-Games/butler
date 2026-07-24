import { expect, test } from "bun:test";
import { taskReviewSubmissionSchema } from "../../packages/butler-agent/src/agent/btcc/review/submission-schema.ts";

test("promotion Review exposes only a satisfied criterion verdict", () => {
  const schema = taskReviewSubmissionSchema("promotion_identity");
  const verdict = criterionVerdictSchema(schema);

  expect(schema.anyOf).toBeUndefined();
  expect(verdict).toEqual({
    type: "object",
    properties: {
      criterionRef: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          sha256: { type: "string", minLength: 1 },
        },
        required: ["id", "sha256"],
        additionalProperties: false,
      },
      observation: { type: "string", minLength: 1 },
      verdict: { type: "string", const: "satisfied" },
    },
    required: ["criterionRef", "observation", "verdict"],
    additionalProperties: false,
  });
});

test("ordinary Task Review separates pass, backlog, and blocking findings", () => {
  const verdict = criterionVerdictSchema(taskReviewSubmissionSchema("semantic"));

  expect(verdict.type).toBeUndefined();
  expect(Array.isArray(verdict.anyOf)).toBe(true);
  expect(verdict.anyOf).toHaveLength(3);
});

test("correction Task Review binds blockers to prior findings or correction regressions", () => {
  const verdict = criterionVerdictSchema(
    taskReviewSubmissionSchema("semantic", ["finding-1"]),
  );
  const serialized = JSON.stringify(verdict);

  expect(verdict.anyOf).toHaveLength(4);
  expect(serialized).toContain('"const":"prior_finding"');
  expect(serialized).toContain('"enum":["finding-1"]');
  expect(serialized).toContain('"const":"correction_regression"');
  expect(serialized).not.toContain('"const":"initial_review"');
});

function criterionVerdictSchema(schema: Record<string, unknown>) {
  const properties = schema.properties as Record<string, unknown>;
  const verdicts = properties.criterionVerdicts as Record<string, unknown>;
  return verdicts.items as Record<string, unknown>;
}
