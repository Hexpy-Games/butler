import { readOperationalMetricEvents } from
  "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import type { AdapterRunInput, AdapterRunResult } from "./contracts.ts";
import { readM1V2DbEvidence } from "./m1-v2-db-evidence.ts";

export async function collectButlerM1V2Evidence(input: {
  benchmark: AdapterRunInput;
  evidence: Record<string, unknown>;
  attemptStartedAtMs: number;
}): Promise<NonNullable<AdapterRunResult["m1V2Evidence"]>> {
  const run = recordValue(input.evidence.run);
  const dataRoot = typeof run?.dataRoot === "string" ? run.dataRoot : null;
  const workspaceRoot = typeof run?.workspaceRoot === "string" ? run.workspaceRoot : null;
  const target = (Array.isArray(input.evidence.observations) ? input.evidence.observations : [])
    .map(recordValue).find((row) => row?.stepId === input.benchmark.fixture.m1V2?.targetStepId);
  const turnId = typeof target?.turnId === "string" ? target.turnId : null;
  if (!dataRoot || !workspaceRoot || !turnId || !input.benchmark.fixture.m1V2) {
    throw new Error("M1 v2 product evidence omitted required run identity");
  }
  return {
    evidence: input.evidence,
    metrics: readOperationalMetricEvents({ butlerData: dataRoot }),
    db: readM1V2DbEvidence(dataRoot, turnId),
    landingValidation: input.benchmark.fixture.m1V2.armId === "landing-cold"
      ? await validateLandingEvidence(input.benchmark.arm.evidenceRoot, workspaceRoot)
      : null,
    sourceRevision: input.benchmark.arm.sourceRevision ?? "",
    attemptStartedAtMs: input.attemptStartedAtMs,
  };
}

async function validateLandingEvidence(runRoot: string, workspaceRoot: string) {
  const { validateM1V2Landing } = await import("./m1-v2-landing-quality.ts");
  return validateM1V2Landing({ runRoot, workspaceRoot });
}

export async function withButlerM1V2Environment<T>(
  input: AdapterRunInput,
  run: () => Promise<T>,
): Promise<T> {
  if (!input.fixture.m1V2) return run();
  const previous = new Map([
    ["BUTLER_M1_V2_SEGMENT_ATTRIBUTION", process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION],
    ["BUTLER_M1_SOURCE_REVISION", process.env.BUTLER_M1_SOURCE_REVISION],
    ["BUTLER_MODEL_API_RETRY_ATTEMPTS", process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS],
  ]);
  process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = "1";
  if (input.arm.sourceRevision) process.env.BUTLER_M1_SOURCE_REVISION = input.arm.sourceRevision;
  process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS = "3";
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
