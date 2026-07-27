import {
  arraySchema,
  objectSchema,
  requireRecord,
  requireString,
  textSchema,
} from "../core/index.ts";
import type { UserReportFacts } from "./contracts.ts";

export const userReportFactsSubmissionSchema = objectSchema({
  outcome: textSchema(),
  materialChanges: arraySchema(textSchema(), { minItems: 1 }),
  validationResults: arraySchema(textSchema(), { minItems: 1 }),
  limitations: arraySchema(textSchema()),
});

export function decodeUserReportFacts(value: unknown): UserReportFacts {
  const report = requireRecord(value, "User report facts");
  return {
    outcome: requireString(report.outcome, "User report outcome"),
    materialChanges: requireTextList(report.materialChanges, "material changes", true),
    validationResults: requireTextList(report.validationResults, "validation results", true),
    limitations: requireTextList(report.limitations, "limitations", false),
  };
}

function requireTextList(
  value: unknown,
  label: string,
  required: true,
): [string, ...string[]];
function requireTextList(value: unknown, label: string, required: false): string[];
function requireTextList(
  value: unknown,
  label: string,
  required: boolean,
): string[] {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new Error(`User report ${label} are invalid`);
  }
  return value.map((item, index) => requireString(item, `${label}[${index}]`));
}
