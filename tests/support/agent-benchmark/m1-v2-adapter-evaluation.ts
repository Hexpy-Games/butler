import type {
  AdapterRunResult,
  BenchmarkArmPlan,
  BenchmarkFixture,
  BenchmarkTerminalState,
} from "./contracts.ts";
import { assessM1V2Repetition } from "./m1-v2-evaluation.ts";
import { m1V2EvidenceIdentityReasons } from "./m1-v2-identity.ts";
import { emptyM1V2Repetition } from "./m1-v2-aggregate.ts";
import type { M1V2RepetitionResult } from "./m1-v2-types.ts";

export function evaluateM1V2AdapterEvidence(input: {
  arm: BenchmarkArmPlan;
  fixture: BenchmarkFixture;
  result: AdapterRunResult;
  terminalState: BenchmarkTerminalState;
}): {
  summary: M1V2RepetitionResult | null;
  terminalState: BenchmarkTerminalState;
  diagnostics: string[];
} {
  if (!input.fixture.m1V2) {
    return { summary: null, terminalState: input.terminalState, diagnostics: [] };
  }
  const evidence = input.result.m1V2Evidence;
  if (!evidence) {
    const status = input.terminalState === "gated" ? "gated" : "rejected";
    const preparedResourceDiagnostic = input.result.stderr.match(
      /\bprepared_resource_[a-z_]+\b/u,
    )?.[0];
    return {
      summary: emptyM1V2Repetition(
        input.fixture.m1V2.armId,
        input.arm.repetition,
        status,
        "m1-v2-evidence-unavailable",
      ),
      terminalState: status,
      diagnostics: [
        "m1-v2-evidence-unavailable",
        ...(preparedResourceDiagnostic ? [preparedResourceDiagnostic] : []),
      ],
    };
  }
  let summary = assessM1V2Repetition({
    armId: input.fixture.m1V2.armId,
    repetition: input.arm.repetition,
    targetStepId: input.fixture.m1V2.targetStepId,
    evidence: evidence.evidence,
    metrics: evidence.metrics,
    db: evidence.db,
    landingValidation: evidence.landingValidation,
    sourceRevision: evidence.sourceRevision,
  });
  const identityReasons = m1V2EvidenceIdentityReasons({
    arm: input.arm,
    fixture: input.fixture,
    evidence: evidence.evidence,
    attemptStartedAtMs: evidence.attemptStartedAtMs,
  });
  if (identityReasons.length > 0) {
    summary = {
      ...summary,
      status: "rejected",
      reasons: [...new Set([...summary.reasons, ...identityReasons])],
    };
  }
  return {
    summary,
    terminalState: summary.status === "accepted" ? "accepted" : summary.status,
    diagnostics: summary.reasons,
  };
}
