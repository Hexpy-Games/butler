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
      findingRootCauseKeys: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      verdict: { type: "string", const: "satisfied" },
    },
    required: ["criterionRef", "observation", "findingRootCauseKeys", "verdict"],
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

test("correction Task Review binds blockers to prior findings or correction regressions", () => {
  const findings = rootFindingSchema(
    taskReviewSubmissionSchema("semantic", ["finding-1"]),
  );
  const serialized = JSON.stringify(findings);

  expect(findings.anyOf).toHaveLength(3);
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

function rootFindingSchema(schema: Record<string, unknown>) {
  const properties = schema.properties as Record<string, unknown>;
  const findings = properties.findings as Record<string, unknown>;
  return findings.items as Record<string, unknown>;
}
