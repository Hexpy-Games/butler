import { expect, test } from "bun:test";
import { taskReviewSubmissionSchema } from "../../packages/butler-agent/src/agent/btcc/review/submission-schema.ts";
import { feedbackPlanReviewSubmissionSchema } from
  "../../packages/butler-agent/src/agent/btcc/planning/submission-schemas.ts";

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
  const schema = taskReviewSubmissionSchema("semantic");
  const verdict = criterionVerdictSchema(schema);
  const findings = rootFindingSchema(schema);

  expect(verdict.type).toBe("object");
  expect(JSON.stringify(verdict)).toContain('"enum":["satisfied","not_satisfied"]');
  expect(findings.anyOf).toHaveLength(2);
});

test("correction Task Review judges frozen root causes without re-authoring them", () => {
  const schema = taskReviewSubmissionSchema("semantic", ["root-cause-1"]);
  const serialized = JSON.stringify(schema);
  const properties = schema.properties as Record<string, Record<string, unknown>>;

  expect(serialized).toContain('"priorFindingVerdicts"');
  expect(serialized).toContain('"enum":["root-cause-1"]');
  expect(serialized).toContain('"enum":["resolved","unresolved","regressed"]');
  expect(serialized).not.toContain('"const":"initial_review"');
  expect(properties.findings?.maxItems).toBe(0);
});

test("Feedback Planning Review names the semantic revision owner", () => {
  const schema = feedbackPlanReviewSubmissionSchema([]);
  const serialized = JSON.stringify(schema);

  expect(serialized).toContain('"revisionTarget"');
  expect(serialized).toContain('"enum":["feedback_plan","feedback_intent"]');
});

function criterionVerdictSchema(schema: Record<string, unknown>) {
  const properties = schema.properties as Record<string, unknown>;
  const verdicts = properties.criterionVerdicts as Record<string, unknown>;
  return verdicts.items as Record<string, unknown>;
}

function rootFindingSchema(schema: Record<string, unknown>) {
  const properties = schema.properties as Record<string, unknown>;
  const findings = properties.findings as Record<string, unknown>;
  return findings.items as Record<string, unknown>;
}
