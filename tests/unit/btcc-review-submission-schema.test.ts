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
      reviewedResultRefs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1 },
            sha256: { type: "string", minLength: 1 },
          },
          required: ["id", "sha256"],
          additionalProperties: false,
        },
        minItems: 1,
      },
      observation: { type: "string", minLength: 1 },
      verdict: { type: "string", const: "satisfied" },
    },
    required: ["criterionRef", "reviewedResultRefs", "observation", "verdict"],
    additionalProperties: false,
  });
});

test("ordinary Task Review retains satisfied and not-satisfied verdicts", () => {
  const verdict = criterionVerdictSchema(taskReviewSubmissionSchema("semantic"));

  expect(verdict.type).toBeUndefined();
  expect(Array.isArray(verdict.anyOf)).toBe(true);
  expect(verdict.anyOf).toHaveLength(2);
});

function criterionVerdictSchema(schema: Record<string, unknown>) {
  const properties = schema.properties as Record<string, unknown>;
  const verdicts = properties.criterionVerdicts as Record<string, unknown>;
  return verdicts.items as Record<string, unknown>;
}
