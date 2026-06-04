import { readFileSync } from "fs";

function assertIncludes(haystack: string, needle: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`expected file to include ${needle}`);
  }
}

const source = readFileSync("packages/butler-agent/scripts/run-worker.ts", "utf8");

assertIncludes(source, "evidence_summary");
assertIncludes(source, "completion_contract");
assertIncludes(source, "completion_review");
assertIncludes(source, "implementation_evidence");
assertIncludes(source, "validation_evidence");
assertIncludes(source, "commit_evidence");
assertIncludes(source, "completionReviewForEvidence");
