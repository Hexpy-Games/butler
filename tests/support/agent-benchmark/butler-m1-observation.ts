import { readOperationalMetricEvents } from
  "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import type { AdapterRunInput, AdapterRunResult } from "./contracts.ts";
import { readM1V2DbEvidence } from "./m1-v2-db-evidence.ts";
import { validateM1V2Landing } from "./m1-v2-landing-quality.ts";

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
      ? await validateM1V2Landing({ runRoot: input.benchmark.arm.evidenceRoot, workspaceRoot })
      : null,
    sourceRevision: input.benchmark.arm.sourceRevision ?? "",
    attemptStartedAtMs: input.attemptStartedAtMs,
  };
}

export function butlerM1V2InfrastructureGate(evidence: Record<string, unknown>): {
  code: "authentication_unavailable" | "measurement_unavailable";
  diagnostic: string;
} | null {
  if (evidence.ok === true) return null;
  const launches = Array.isArray(evidence.launches) ? evidence.launches : [];
  if (launches.length === 0) {
    return { code: "measurement_unavailable", diagnostic: "Butler Electron/App setup did not reach a product launch." };
  }
  const requests = Array.isArray(evidence.providerRequests)
    ? evidence.providerRequests.map(recordValue).filter((row): row is Record<string, unknown> => Boolean(row))
    : [];
  if (requests.some((request) => request.status === 401 || request.status === 403)) {
    return { code: "authentication_unavailable", diagnostic: "Butler provider authentication gated the M1 arm." };
  }
  if (requests.some((request) => request.status === 429) ||
    requests.length > 0 && requests.every((request) => request.status === null && request.termination === "failed")) {
    return { code: "measurement_unavailable", diagnostic: "Butler provider quota or network availability gated the M1 arm." };
  }
  return null;
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
