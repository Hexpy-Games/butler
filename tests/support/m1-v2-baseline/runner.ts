import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readOperationalMetricEvents } from
  "../../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";
import { runBtccR3ElectronHarness } from
  "../../e2e/btcc-r3-electron-harness.ts";
import { assessM1V2Repetition } from "./assess.ts";
import { buildCampaignResult, gatedResult } from "./aggregate.ts";
import type {
  M1V2CampaignConfig,
  M1V2CampaignDependencies,
  M1V2CampaignResult,
  M1V2RepetitionResult,
} from "./contracts.ts";
import { readM1V2DbEvidence } from "./db-evidence.ts";
import { loadCanonicalM1V2Fixtures } from "./fixtures.ts";
import { validateM1V2Landing } from "./landing-validation.ts";
import { type M1V2ManifestRun, writeM1V2Manifest } from "./manifest.ts";

export async function runM1V2BaselineCampaign(
  config: M1V2CampaignConfig,
  dependencies: M1V2CampaignDependencies = {},
): Promise<M1V2CampaignResult> {
  if (!Number.isSafeInteger(config.repetitions) ||
    config.repetitions < 3 || config.repetitions > 10) {
    throw new Error("M1 v2 repetitions must be an integer between 3 and 10.");
  }
  const outputRoot = resolve(config.outputRoot);
  const repoRoot = resolve(config.repoRoot);
  const sourceData = resolve(config.sourceData);
  const fixtures = loadCanonicalM1V2Fixtures(repoRoot);
  mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
  const manifest = writeM1V2Manifest(outputRoot, config, fixtures);
  const runHarness = dependencies.runHarness ?? runBtccR3ElectronHarness;
  const readMetrics = dependencies.readMetrics ?? ((butlerData: string) =>
    readOperationalMetricEvents({ butlerData }));
  const assess = dependencies.assess ?? assessM1V2Repetition;
  const readDb = dependencies.readDb ?? readM1V2DbEvidence;
  const validateLanding = dependencies.validateLanding ?? validateM1V2Landing;
  const repetitions: M1V2RepetitionResult[] = [];
  let infrastructureStopped = false;
  const previousFlag = process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION;
  const previousRevision = process.env.BUTLER_M1_SOURCE_REVISION;
  const previousRetryAttempts = process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS;
  process.env.BUTLER_M1_V2_SEGMENT_ATTRIBUTION = "1";
  process.env.BUTLER_MODEL_API_RETRY_ATTEMPTS = "3";
  if (config.sourceRevision) process.env.BUTLER_M1_SOURCE_REVISION = config.sourceRevision;
  try {
    for (const fixture of fixtures) {
      for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
        if (infrastructureStopped) break;
        const manifestRun = manifest.runs.find((run) =>
          run.armId === fixture.armId && run.repetition === repetition);
        if (!manifestRun) throw new Error("M1 v2 manifest run identity is missing.");
        const runRoot = join(outputRoot, manifestRun.runKey);
        reserveFreshRun(outputRoot, runRoot, manifest.campaignId, manifestRun);
        const scenario = structuredClone(fixture.scenario);
        scenario.id = manifestRun.scenarioId;
        if (scenario.session) scenario.session.id = scenario.id;
        const attemptStartedAtMs = Date.now();
        try {
          let evidence: Record<string, unknown>;
          try {
            evidence = await runHarness(scenario, {
              accessMode: "full_access",
              model: "openai/gpt-5.6-sol",
              reasoningEffort: "medium",
              repoRoot,
              runRoot,
              sourceData,
            });
          } catch {
            const failedEvidence = readFailedEvidence(runRoot, manifestRun, attemptStartedAtMs);
            const gateReason = infrastructureGateReason(failedEvidence);
            if (gateReason) throw new M1CampaignInfrastructureGate(gateReason);
            if (!failedEvidence) {
              throw new M1CampaignInfrastructureGate("missing_failure_evidence");
            }
            evidence = failedEvidence;
          }
          validateEvidenceIdentity(
            evidence,
            manifestRun,
            runRoot,
            attemptStartedAtMs,
            evidence.ok === true,
          );
          const run = recordValue(evidence.run);
          const dataRoot = stringValue(run?.dataRoot);
          const workspaceRoot = stringValue(run?.workspaceRoot);
          if (!dataRoot || !workspaceRoot) {
            throw new M1CampaignInfrastructureGate("missing_run_roots");
          }
          const target = recordArray(evidence.observations).find((observation) =>
            observation.stepId === fixture.targetStepId);
          const turnId = stringValue(target?.turnId);
          let db = null;
          if (turnId) {
            try {
              db = readDb(dataRoot, turnId);
            } catch {
              throw new M1CampaignInfrastructureGate("database_evidence_unavailable");
            }
          }
          let landingValidation = null;
          if (fixture.armId === "landing-cold" && target) {
            try {
              landingValidation = await validateLanding({
                browserExecutablePath: config.browserExecutablePath,
                runRoot,
                workspaceRoot,
              });
            } catch {
              throw new M1CampaignInfrastructureGate("landing_browser_or_build_gate");
            }
          }
          repetitions.push(assess({
            armId: fixture.armId,
            repetition,
            targetStepId: fixture.targetStepId,
            evidence,
            metrics: readMetrics(dataRoot),
            db,
            landingValidation,
            sourceRevision: manifest.sourceRevision,
          }));
        } catch (error) {
          if (!(error instanceof M1CampaignInfrastructureGate)) throw error;
          repetitions.push(gatedResult(fixture.armId, repetition, error.message));
          infrastructureStopped = true;
        }
        writeCampaign(outputRoot, buildCampaignResult(config.repetitions, repetitions));
      }
      if (infrastructureStopped) break;
    }
  } finally {
    restoreEnv("BUTLER_M1_V2_SEGMENT_ATTRIBUTION", previousFlag);
    restoreEnv("BUTLER_M1_SOURCE_REVISION", previousRevision);
    restoreEnv("BUTLER_MODEL_API_RETRY_ATTEMPTS", previousRetryAttempts);
  }
  const result = buildCampaignResult(config.repetitions, repetitions);
  writeCampaign(outputRoot, result);
  return result;
}

function writeCampaign(outputRoot: string, result: M1V2CampaignResult): void {
  writeFileSync(
    join(outputRoot, "campaign.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function reserveFreshRun(
  outputRoot: string,
  runRoot: string,
  campaignId: string,
  run: M1V2ManifestRun,
): void {
  if (existsSync(runRoot)) {
    throw new M1CampaignInfrastructureGate("run_root_not_fresh");
  }
  mkdirSync(join(outputRoot, run.armId), { recursive: true, mode: 0o700 });
  writeFileSync(`${runRoot}.reservation.json`, `${JSON.stringify({
    schema: "butler.m1-v2-run-reservation.v1",
    campaignId,
    runKey: run.runKey,
    scenarioId: run.scenarioId,
  })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (existsSync(runRoot)) {
    throw new M1CampaignInfrastructureGate("run_root_raced_before_launch");
  }
}

function readFailedEvidence(
  runRoot: string,
  manifestRun: M1V2ManifestRun,
  attemptStartedAtMs: number,
): Record<string, unknown> | null {
  const path = join(runRoot, "evidence.json");
  if (!existsSync(path)) return null;
  if (statSync(path).mtimeMs < attemptStartedAtMs) {
    throw new M1CampaignInfrastructureGate("stale_failure_evidence");
  }
  let evidence: Record<string, unknown> | null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    evidence = recordValue(parsed) ?? null;
  } catch {
    return null;
  }
  if (!evidence) return null;
  validateEvidenceIdentity(evidence, manifestRun, runRoot, attemptStartedAtMs, false);
  return evidence;
}

function validateEvidenceIdentity(
  evidence: Record<string, unknown>,
  manifestRun: M1V2ManifestRun,
  runRoot: string,
  attemptStartedAtMs: number,
  requireComplete: boolean,
): void {
  const run = recordValue(evidence.run);
  const evidenceRunRoot = stringValue(run?.runRoot);
  const runId = stringValue(run?.runId);
  const generatedAt = stringValue(evidence.generatedAt);
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (evidenceRunRoot === null || resolve(evidenceRunRoot) !== resolve(runRoot) ||
    !runId?.startsWith(`${manifestRun.scenarioId}-`) ||
    !Number.isFinite(generatedAtMs) || generatedAtMs < attemptStartedAtMs - 1_000) {
    throw new M1CampaignInfrastructureGate("evidence_identity_mismatch");
  }
  if (!requireComplete) return;
  const session = recordValue(evidence.session);
  const target = recordArray(evidence.observations).find((row) =>
    row.stepId === manifestRun.targetStepId);
  if (run?.model !== "openai/gpt-5.6-sol" || run?.reasoningEffort !== "medium" ||
    session?.id !== manifestRun.scenarioId ||
    target?.promptSha256 !== manifestRun.targetPromptSha256) {
    throw new M1CampaignInfrastructureGate("evidence_manifest_binding_mismatch");
  }
}

function infrastructureGateReason(
  evidence: Record<string, unknown> | null,
): string | null {
  if (!evidence) return "missing_failure_evidence";
  const launches = recordArray(evidence.launches);
  if (launches.length === 0) return "electron_or_setup_gate";
  const requests = recordArray(evidence.providerRequests);
  if (requests.some((request) => [401, 403].includes(Number(request.status)))) {
    return "provider_auth_gate";
  }
  if (requests.some((request) => Number(request.status) === 429)) {
    return "provider_quota_gate";
  }
  if (requests.length > 0 && requests.every((request) =>
    request.status === null && request.termination === "failed")) {
    return "provider_network_gate";
  }
  return null;
}

class M1CampaignInfrastructureGate extends Error {}
