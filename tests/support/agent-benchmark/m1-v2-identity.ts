import { resolve } from "node:path";
import type { BenchmarkArmPlan, BenchmarkFixture } from "./contracts.ts";

export function m1V2EvidenceIdentityReasons(input: {
  arm: BenchmarkArmPlan;
  fixture: BenchmarkFixture;
  evidence: Record<string, unknown>;
  attemptStartedAtMs: number;
}): string[] {
  if (!input.fixture.m1V2) return [];
  const reasons: string[] = [];
  const run = recordValue(input.evidence.run);
  const session = recordValue(input.evidence.session);
  const observations = Array.isArray(input.evidence.observations)
    ? input.evidence.observations.map(recordValue)
      .filter((row): row is Record<string, unknown> => Boolean(row))
    : [];
  const target = observations.find((row) =>
    row.stepId === input.fixture.m1V2?.targetStepId);
  if (typeof run?.runRoot !== "string" ||
    resolve(run.runRoot) !== resolve(input.arm.evidenceRoot)) {
    reasons.push("evidence_identity_mismatch");
  }
  if (run?.model !== "openai/gpt-5.6-sol" || run?.reasoningEffort !== "medium") {
    reasons.push("evidence_model_identity_mismatch");
  }
  const expectedSessionId = `agent-benchmark-${input.arm.key.replaceAll(":", "-")}`;
  if (typeof session?.id !== "string" || session.id !== expectedSessionId) {
    reasons.push("evidence_session_identity_mismatch");
  }
  if (target?.promptSha256 !==
    input.fixture.m1V2.promptSha256[input.fixture.m1V2.targetStepId]) {
    reasons.push("evidence_prompt_hash_mismatch");
  }
  const generatedAt = typeof input.evidence.generatedAt === "string"
    ? Date.parse(input.evidence.generatedAt)
    : Number.NaN;
  if (!Number.isFinite(generatedAt)) reasons.push("evidence_timestamp_invalid");
  else if (generatedAt < input.attemptStartedAtMs - 1_000) {
    reasons.push("stale_evidence_mismatch");
  }
  return reasons;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
