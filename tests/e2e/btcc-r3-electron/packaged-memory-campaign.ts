import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StepObservation } from "./contracts.ts";
import { prepareElectronRun } from "./isolation-config.ts";
import {
  ensureSession,
  launchProduct,
  stopProduct,
  type ProductLaunch,
} from "./product-launch.ts";
import {
  startProviderObservationProxy,
  type ProviderObservationProxy,
} from "./provider-observation-proxy.ts";
import { runScenarioStep } from "./scenario-step.ts";
import {
  captureCampaignSnapshot,
  createCampaignScenario,
  DEFAULT_MODEL,
  discoverCampaignWithRetry,
  seedLargeHistory,
  seedVectorFixture,
} from "./packaged-memory-campaign-setup.ts";
import {
  evaluateCampaignCorrectness,
  CampaignFailure,
  normalizeCampaignError,
  PACKAGED_MEMORY_CAMPAIGN_SCHEMA,
  type PackagedMemoryCampaignOptions,
  type PackagedMemoryCampaignResult,
} from "./packaged-memory-campaign-contracts.ts";
export {
  PACKAGED_MEMORY_CAMPAIGN_SCHEMA,
  REQUIRED_CAMPAIGN_CHECKS,
  evaluateCampaignCorrectness,
} from "./packaged-memory-campaign-contracts.ts";
import {
  currentMessageCursorToken,
  exercisePublicReadPath,
  settlePublicReadPathTeardown,
} from "./packaged-memory-campaign-read-path.ts";
import {
  computeSourceFingerprint,
  digestFixturePath,
  digestModelCacheCandidates,
  digestRuntimeCacheResource,
  digestSeededHistory,
  executableName,
  executableVersion,
  fingerprint,
  managedRuntimeExecutablePath,
  modelCacheCandidates,
  PACKAGED_MEMORY_CACHE_POLICY,
  portableValueFingerprint,
  summarizeRolePhysicalMemorySeries,
} from "./packaged-memory-campaign-evidence.ts";
import {
  hasCompleteProcessAttribution,
} from "./packaged-memory-processes.ts";
import {
  type PackagedPerformanceSnapshot,
  type PackagedProcessTarget,
} from "../../support/packaged-performance-snapshot.ts";
import {
  CANDIDATE_BUN_VERSION,
  PINNED_BUN_VERSION,
} from "../../support/bun-runtime-ab.ts";
import {
  evaluatePhysicalMemoryGate,
  type EmbedIdleReclamation,
} from "../../support/physical-memory-gate.ts";

export async function runPackagedMemoryCampaign(
  options: PackagedMemoryCampaignOptions = {},
): Promise<PackagedMemoryCampaignResult> {
  const runtimeVariant = options.runtimeVariant ?? "pinned";
  const expectedBunVersion = runtimeVariant === "candidate"
    ? CANDIDATE_BUN_VERSION
    : PINNED_BUN_VERSION;
  const warmupCycles = Math.max(3, Math.trunc(options.warmupCycles ?? 3));
  const steadyCycles = Math.max(6, Math.trunc(options.steadyCycles ?? 6));
  const historyMessages = Math.max(100, Math.trunc(options.historyMessages ?? 1_200));
  const idleWaitMs = Math.max(45_000, Math.trunc(options.idleWaitMs ?? 47_000));
  const campaignScenario = createCampaignScenario(warmupCycles + steadyCycles);
  const previousManagedBun = process.env.BUTLER_APP_MANAGED_BUN;
  const previousButlerBun = process.env.BUTLER_BUN;
  process.env.BUTLER_APP_MANAGED_BUN = process.execPath;
  process.env.BUTLER_BUN = process.execPath;
  let run: Awaited<ReturnType<typeof prepareElectronRun>>;
  try {
    run = await prepareElectronRun(campaignScenario, {
      ...options,
      model: options.model ?? DEFAULT_MODEL,
      reasoningEffort: options.reasoningEffort ?? "low",
      accessMode: options.accessMode ?? "full_access",
    });
  } finally {
    if (previousManagedBun === undefined) delete process.env.BUTLER_APP_MANAGED_BUN;
    else process.env.BUTLER_APP_MANAGED_BUN = previousManagedBun;
    if (previousButlerBun === undefined) delete process.env.BUTLER_BUN;
    else process.env.BUTLER_BUN = previousButlerBun;
  }
  let launch: ProductLaunch | null = null;
  let proxy: ProviderObservationProxy | null = null;
  let processTargets: PackagedProcessTarget[] = [];
  const cycles: PackagedPerformanceSnapshot[] = [];
  let loadedEmbedSnapshot: PackagedPerformanceSnapshot | null = null;
  let idle: PackagedPerformanceSnapshot | null = null;
  const checks: string[] = [];
  const terminalStates: string[] = [];
  let campaignError: ReturnType<typeof normalizeCampaignError> | undefined;
  const recordCampaignError = (
    error: unknown,
    fallback: Parameters<typeof normalizeCampaignError>[1] = "campaign_unknown",
  ): void => {
    campaignError ??= normalizeCampaignError(error, fallback);
  };
  let seededDataFingerprint = "";
  let cacheResourceDigest = "";
  let modelCacheDigest = "";
  let managedRuntimePath: string | null = null;
  let managedBunVersion = "";
  let bundledRuntimePath: string | null = null;
  let bundledBunVersion = "";
  const previousEmbedRecycle = process.env.EMBED_IDLE_RECYCLE_MS;
  mkdirSync(join(run.dataRoot, "app-server"), { recursive: true, mode: 0o700 });
  await (async () => {
    const { AppServerStore } = await import("../../../packages/butler-agent/src/gateways/app/application/store/app-server-store.ts");
    const store = new AppServerStore({
      dbPath: join(run.dataRoot, "app-server", "butler-client.sqlite"),
      butlerData: run.dataRoot,
      butlerHome: run.repoRoot,
    });
    try {
      const created = store.createSession({
        kind: "chat",
        title: "RMF-SC09 repeat-use campaign",
        session_hint: run.sessionId,
        idempotency_key: `rmf-sc09:${run.runId}`,
      });
      if (created.session.id !== run.sessionId) {
        throw new Error("canonical prelaunch history seed created an unexpected session id");
      }
    } finally {
      store.close();
    }
  })();
  await seedLargeHistory(run, historyMessages);
  try {
    const vectorFixtureReady = seedVectorFixture(run);
    if (!vectorFixtureReady) {
      throw new CampaignFailure("campaign_seed_failed", "vector fixture unavailable");
    }
    seededDataFingerprint = fingerprint({
      history: digestSeededHistory(join(run.dataRoot, "app-server", "butler-client.sqlite"), run.sessionId),
      vector: digestFixturePath(join(run.dataRoot, "cognition", "memory", "db", "butler.lance")),
    });
    const vectorCacheDigest = digestFixturePath(join(run.dataRoot, "cognition", "memory", "db", "butler.lance"));
    const runtimeResourceRoot = run.bundledAgentResourceDir
      ? join(run.bundledAgentResourceDir, "runtime")
      : null;
    const runtimeResourceDigest = runtimeResourceRoot && existsSync(runtimeResourceRoot)
      ? digestRuntimeCacheResource(runtimeResourceRoot)
      : "";
    cacheResourceDigest = fingerprint({
      model: run.model,
      vector: vectorCacheDigest,
      runtimeResource: runtimeResourceDigest,
    });
    if (!runtimeResourceDigest) {
      recordCampaignError(
        new CampaignFailure("campaign_cache_digest_unavailable", "runtime resource digest unavailable"),
      );
    }
    process.env.EMBED_IDLE_RECYCLE_MS = "45000";
    proxy = await startProviderObservationProxy({
      upstreamBaseUrl: process.env.BUTLER_CODEX_BASE_URL,
      fixture: campaignScenario.providerFixture,
    });
    launch = await launchProduct(run, proxy.endpoint);
    await ensureSession(run, launch);
    managedRuntimePath = managedRuntimeExecutablePath(run);
    managedBunVersion = executableVersion(managedRuntimePath);
    bundledRuntimePath = run.bundledAgentResourceDir
      ? join(run.bundledAgentResourceDir, "runtime", "bin", process.platform === "win32" ? "bun.exe" : "bun")
      : null;
    bundledBunVersion = executableVersion(bundledRuntimePath);
    if (process.versions.bun !== expectedBunVersion) {
      recordCampaignError(
        new CampaignFailure("campaign_runtime_identity_failed", "outer Bun version mismatch"),
      );
    }
    if (bundledBunVersion !== expectedBunVersion) {
      recordCampaignError(
        new CampaignFailure("campaign_runtime_identity_failed", "bundled Bun version mismatch"),
      );
    }
    if (managedBunVersion !== expectedBunVersion) {
      recordCampaignError(
        new CampaignFailure("campaign_runtime_identity_failed", "managed Bun version mismatch"),
      );
    }
    processTargets = await discoverCampaignWithRetry(run, launch);
    if (!hasCompleteProcessAttribution(processTargets)) {
      throw new CampaignFailure(
        "campaign_process_attribution_failed",
        "declared process attribution incomplete",
      );
    }
    cycles.push(captureCampaignSnapshot(run, processTargets, "warmup", 0, "unloaded-baseline"));
    for (let index = 0; index < warmupCycles; index += 1) {
      const messageCursorBefore = await currentMessageCursorToken(launch, run.sessionId);
      const terminal = await runScenarioStep(
        run,
        launch,
        {
          id: `provider-recall-${index}`,
          prompt: "Use recall_memory with the supplied vector strategy before replying.",
          reloadAfter: false,
          expect: { terminalState: "delivered" },
        },
        new Map<string, StepObservation>(),
        proxy,
      );
      terminalStates.push(terminal.terminalState);
      if (terminal.terminalState !== "delivered") {
        throw new CampaignFailure(
          "campaign_provider_terminal_failed",
          "provider recall terminal path did not deliver",
        );
      }
      checks.push("provider-terminal");
      const loadedTargets = await discoverCampaignWithRetry(run, launch);
      loadedEmbedSnapshot = captureCampaignSnapshot(run, loadedTargets, "warmup", index + 1, "embed-loaded");
      checks.push(...await exercisePublicReadPath(launch, run.sessionId, messageCursorBefore));
      await settlePublicReadPathTeardown(launch);
      processTargets = loadedTargets;
      cycles.push(captureCampaignSnapshot(run, loadedTargets, "warmup", index + 1, "warmup-read-refresh"));
    }
    for (let index = 0; index < steadyCycles; index += 1) {
      const messageCursorBefore = await currentMessageCursorToken(launch, run.sessionId);
      const terminal = await runScenarioStep(
        run,
        launch,
        {
          id: `provider-recall-steady-${index}`,
          prompt: "Use recall_memory with the supplied vector strategy before replying.",
          reloadAfter: false,
          expect: { terminalState: "delivered" },
        },
        new Map<string, StepObservation>(),
        proxy,
      );
      terminalStates.push(terminal.terminalState);
      if (terminal.terminalState !== "delivered") {
        throw new CampaignFailure(
          "campaign_provider_terminal_failed",
          "steady provider recall did not deliver",
        );
      }
      const loadedTargets = await discoverCampaignWithRetry(run, launch);
      loadedEmbedSnapshot = captureCampaignSnapshot(run, loadedTargets, "steady", index, "embed-loaded");
      checks.push(...await exercisePublicReadPath(launch, run.sessionId, messageCursorBefore));
      await settlePublicReadPathTeardown(launch);
      processTargets = loadedTargets;
      cycles.push(captureCampaignSnapshot(run, loadedTargets, "steady", index, "steady-read-refresh"));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, idleWaitMs));
    const idleTargets = await discoverCampaignWithRetry(run, launch);
    idle = captureCampaignSnapshot(run, idleTargets, "idle", steadyCycles + warmupCycles + 1, "idle-reclamation");
    processTargets = idleTargets;
    checks.push("owned-sidecar-lifecycle");
    modelCacheDigest = digestModelCacheCandidates(modelCacheCandidates(managedRuntimePath));
    if (!modelCacheDigest) {
      recordCampaignError(
        new CampaignFailure(
          "campaign_cache_digest_unavailable",
          "model cache digest unavailable after embedding requests",
        ),
      );
    }
  } catch (error) {
    recordCampaignError(error);
  } finally {
    if (!modelCacheDigest && managedRuntimePath) {
      try {
        modelCacheDigest = digestModelCacheCandidates(modelCacheCandidates(managedRuntimePath));
      } catch {
        // The final evidence assembly records the cache digest failure without
        // replacing a primary provider/read-path failure.
      }
    }
    if (launch) await stopProduct(run, launch).catch(() => undefined);
    if (proxy) await proxy.close().catch(() => undefined);
    if (previousEmbedRecycle === undefined) delete process.env.EMBED_IDLE_RECYCLE_MS;
    else process.env.EMBED_IDLE_RECYCLE_MS = previousEmbedRecycle;
  }
  const embed = (sample: PackagedPerformanceSnapshot | null) =>
    sample?.processes.find((process) => process.role === "embed")?.physicalFootprintBytes ?? null;
  const idleReclamation: EmbedIdleReclamation | null = idle
    ? {
        baselineBytes: embed(cycles[0] ?? null),
        loadedBytes: embed(loadedEmbedSnapshot),
        afterIdleBytes: embed(idle),
      }
    : null;
  const physicalGate = evaluatePhysicalMemoryGate({
    cycles,
    ...(idleReclamation ? { idleReclamation } : {}),
    warmupCycles: warmupCycles + 1,
    requiredProcessTargets: processTargets,
  });
  const observedChecks = new Set(checks);
  const correctnessOk = evaluateCampaignCorrectness(checks, terminalStates);
  const sourceEvidence = computeSourceFingerprint(run.repoRoot);
  const sourceFingerprint = sourceEvidence.fingerprint;
  if (sourceEvidence.error) {
    recordCampaignError(
      new CampaignFailure("campaign_fingerprint_failed", "source fingerprint unavailable"),
    );
  }
  const dataFingerprint = seededDataFingerprint;
  if (!dataFingerprint) {
    recordCampaignError(
      new CampaignFailure("campaign_seed_failed", "seeded fixture digest unavailable"),
    );
  }
  const cachePolicy = PACKAGED_MEMORY_CACHE_POLICY;
  if (!cacheResourceDigest || !modelCacheDigest) {
    recordCampaignError(
      new CampaignFailure("campaign_cache_digest_unavailable", "runtime/model cache digest unavailable"),
    );
  }
  const combinedCacheResourceDigest = cacheResourceDigest && modelCacheDigest
    ? fingerprint({ resource: cacheResourceDigest, model: modelCacheDigest })
    : "";
  const cacheFingerprint = combinedCacheResourceDigest
    ? fingerprint({ policy: cachePolicy, resource: combinedCacheResourceDigest })
    : "";
  const archiveStream = options.archiveStreamEvidence ?? {
    ok: false,
    reason: "archive-stream guard evidence was not supplied",
    attempts: 0,
    successes: 0,
  };
  const packaging = options.packagingEvidence ?? {
    ok: false,
    reason: "release packaging evidence was not supplied",
    attempts: 0,
    successes: 0,
  };
  const expectedEvidenceVersion = expectedBunVersion;
  for (const [label, evidence] of [["archive", archiveStream], ["packaging", packaging]] as const) {
    if (evidence.ok && (
      evidence.bunVersion !== expectedEvidenceVersion ||
      !evidence.executableLabel ||
      !evidence.executableFingerprint ||
      !evidence.commandLabel ||
      !evidence.commandFingerprint
    )) {
      recordCampaignError(
        new CampaignFailure("campaign_guard_evidence_invalid", `${label} guard identity invalid`),
      );
    }
  }
  const result: PackagedMemoryCampaignResult = {
    schema: PACKAGED_MEMORY_CAMPAIGN_SCHEMA,
    ok: physicalGate.ok,
    variant: runtimeVariant,
    runtime: {
      executableName: executableName(process.execPath),
      executableFingerprint: portableValueFingerprint(process.execPath),
      bunVersion: process.versions.bun ?? "unknown",
      managedExecutableName: executableName(managedRuntimePath),
      managedExecutableFingerprint: portableValueFingerprint(managedRuntimePath),
      managedBunVersion,
      bundledExecutableName: executableName(bundledRuntimePath),
      bundledExecutableFingerprint: portableValueFingerprint(bundledRuntimePath),
      bundledBunVersion,
    },
    sourceFingerprint,
    dataFingerprint,
    cacheFingerprint,
    cachePolicy,
    cacheResourceDigest: combinedCacheResourceDigest,
    modelCacheDigest,
    warmupCycles,
    steadyCycles,
    processTargets,
    cycles,
    rolePhysicalMemorySeries: summarizeRolePhysicalMemorySeries(cycles),
    idle,
    idleReclamation,
    physicalGate,
    correctness: { ok: correctnessOk, checks: [...observedChecks] },
    archiveStream,
    packaging,
    providerTerminalStates: terminalStates,
    ...(campaignError ? { error: campaignError } : {}),
  };
  result.ok = result.ok &&
    Boolean(result.sourceFingerprint) &&
    Boolean(result.dataFingerprint) &&
    Boolean(result.cacheFingerprint) &&
    process.versions.bun === expectedBunVersion &&
    result.runtime.bundledBunVersion === expectedBunVersion &&
    result.runtime.managedBunVersion === expectedBunVersion &&
    result.correctness.ok &&
    result.archiveStream.ok &&
    result.packaging.ok &&
    result.archiveStream.bunVersion === expectedEvidenceVersion &&
    result.packaging.bunVersion === expectedEvidenceVersion &&
    Boolean(result.archiveStream.executableLabel) &&
    Boolean(result.archiveStream.executableFingerprint) &&
    Boolean(result.packaging.executableLabel) &&
    Boolean(result.packaging.executableFingerprint) &&
    !campaignError;
  return result;
}

if (import.meta.main) {
  const result = await runPackagedMemoryCampaign({
    repoRoot: process.env.BUTLER_RMF_REPO_ROOT,
    sourceData: process.env.BUTLER_RMF_SOURCE_DATA,
    runRoot: process.env.BUTLER_RMF_RUN_ROOT,
    runtimeVariant: process.env.BUTLER_RMF_RUNTIME_VARIANT === "candidate" ? "candidate" : "pinned",
    warmupCycles: process.env.BUTLER_RMF_WARMUP_CYCLES ? Number(process.env.BUTLER_RMF_WARMUP_CYCLES) : undefined,
    steadyCycles: process.env.BUTLER_RMF_STEADY_CYCLES ? Number(process.env.BUTLER_RMF_STEADY_CYCLES) : undefined,
    historyMessages: process.env.BUTLER_RMF_HISTORY_MESSAGES ? Number(process.env.BUTLER_RMF_HISTORY_MESSAGES) : undefined,
    idleWaitMs: process.env.BUTLER_RMF_IDLE_WAIT_MS ? Number(process.env.BUTLER_RMF_IDLE_WAIT_MS) : undefined,
    keepLogs: true,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
