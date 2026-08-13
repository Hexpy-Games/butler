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
import { exportedM1V2Metrics, verifyM1V2DurableProjection } from "./m1-v2-evidence-export.ts";

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
  let metrics = evidence.metrics;
  let durableArithmetic: ReturnType<typeof verifyM1V2DurableProjection>["arithmetic"] | null = null;
  let targetEvidenceIdentity: { sessionId: string; turnId: string } | null = null;
  if (evidence.exportPath && evidence.exportSha256 && evidence.exportHandle && evidence.exportRunRoot && evidence.exportPlanIdentity) {
    try {
      if (!evidence.exportIdentity) throw new Error("sc01_export_evaluator_identity_missing");
      const target = Array.isArray(evidence.evidence.observations) ? evidence.evidence.observations.find((row) => row && typeof row === "object" && (row as Record<string, unknown>).stepId === input.fixture.m1V2!.targetStepId) as Record<string, unknown> | undefined : undefined;
      if (typeof target?.sessionId !== "string" || typeof target.turnId !== "string") throw new Error("sc01_export_evaluator_target_identity_missing");
      targetEvidenceIdentity = { sessionId: target.sessionId, turnId: target.turnId };
      const verified = verifyM1V2DurableProjection({ planIdentity: evidence.exportPlanIdentity, runRoot: evidence.exportRunRoot,
        arm: input.arm, fixture: input.fixture, target: { sessionId: target.sessionId, turnId: target.turnId },
        durable: { handle: evidence.exportHandle, sha256: evidence.exportSha256, identity: evidence.exportIdentity } });
      durableArithmetic = verified.arithmetic;
      metrics = exportedM1V2Metrics(verified.evidence);
    } catch {
      return {
        summary: emptyM1V2Repetition(input.fixture.m1V2.armId, input.arm.repetition, "gated", "sc01_durable_evidence_export_verification_failed"),
        terminalState: "gated",
        diagnostics: ["sc01_durable_evidence_export_verification_failed"],
      };
    }
  }
  let summary = assessM1V2Repetition({
    armId: input.fixture.m1V2.armId,
    repetition: input.arm.repetition,
    targetStepId: input.fixture.m1V2.targetStepId,
    evidence: evidence.evidence,
    metrics,
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
  if (durableArithmetic) summary = { ...summary, ...durableArithmetic };
  if (targetEvidenceIdentity) summary = { ...summary, targetEvidenceIdentity };
  if (evidence.exportHandle && evidence.exportSha256) {
    summary = { ...summary, durableEvidence: { handle: evidence.exportHandle, sha256: evidence.exportSha256, identity: evidence.exportIdentity! } };
  }
  return {
    summary,
    terminalState: summary.status === "accepted" ? "accepted" : summary.status,
    diagnostics: summary.reasons,
  };
}
