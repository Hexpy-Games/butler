import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { runBtccR3ElectronHarness, type ElectronScenario } from "../../e2e/btcc-r3-electron-harness.ts";
import type { AdapterRunInput, AdapterRunResult, AgentAdapter, PreflightResult } from "./contracts.ts";
import type { BenchmarkTarget } from "../btcc-revision-benchmark/contracts.ts";
import { firstMeaningfulEventTime, readProductUsage, readTurnEvents, summarizeTools } from "../btcc-revision-benchmark/product-telemetry.ts";
import { readRepositoryEvidenceFiles, verifyEvidenceWorkspace } from "./repository-evidence.ts";
import { benchmarkPlatformGate } from "./isolation.ts";
import {
  boundedUsefulTime,
  copyGeneratedArtifacts,
  gatedAdapterResult,
  readButlerVersion,
  rootsOverlap,
  sumNullable,
} from "./butler-output.ts";
import { sanitizeIdentifier } from "./identifiers.ts";
import { cleanupButlerRuntime, prunePrivateButlerEvidenceCorpus, readButlerHarnessEvidence, removeRawButlerHarnessEvidence } from "./butler-runtime-cleanup.ts";
import {
  collectButlerM1V2Evidence,
  withButlerM1V2Environment,
} from "./butler-m1-observation.ts";
import { butlerM1V2InfrastructureGate } from "./butler-infrastructure-gate.ts";
import {
  PreparedButlerResourceError,
  type PreparedButlerResourceReference,
  withPreparedButlerResource,
} from "./prepared-butler-resource.ts";
import {
  electronReasoning,
  promptCacheKeyPrefixForPair,
} from "./electron-runner-config.ts";
import { projectButlerAdapterFailure } from "./butler-failure-evidence.ts";
export { promptCacheKeyPrefixForPair } from "./electron-runner-config.ts";

export type ButlerBenchmarkRunner = (input: AdapterRunInput) => Promise<Record<string, unknown>>;

export function createButlerAdapter(
  runner: ButlerBenchmarkRunner,
  sourceRoot: string,
): AgentAdapter {
  let adapterVersion: string | null = null;
  return {
    agent: "butler",
    async preflight(): Promise<PreflightResult> {
      const platformDiagnostic = benchmarkPlatformGate();
      if (platformDiagnostic) {
        return { available: false, executable: null, version: null, authenticated: null, configVerified: false, gateCode: "configuration_unverifiable", diagnostic: platformDiagnostic };
      }
      const packagePath = join(sourceRoot, "package.json");
      if (!existsSync(packagePath)) {
        return {
          available: false,
          executable: null,
          version: null,
          authenticated: null,
          configVerified: false,
          gateCode: "configuration_unverifiable",
          diagnostic: "Butler package metadata was not found in the pinned source root.",
        };
      }
      adapterVersion = sanitizeIdentifier(readButlerVersion(packagePath));
      return {
        available: true,
        executable: "butler-electron-harness",
        version: adapterVersion,
        authenticated: null,
        configVerified: true,
        gateCode: "none",
        diagnostic: null,
      };
    },
    async run(input: AdapterRunInput): Promise<AdapterRunResult> {
      const startedAtMs = Date.now();
      let evidence: Record<string, unknown> = { error: true, run: { dataRoot: join(input.arm.evidenceRoot, "data") } };
      let runnerError: unknown = null;
      let adapterResult: AdapterRunResult | null = null;
      try {
        evidence = await runner(input);
      } catch (error) {
        runnerError = error;
        const recoveredEvidence = readButlerHarnessEvidence(input.arm.evidenceRoot);
        if (recoveredEvidence) {
          evidence = recoveredEvidence;
        } else if (error instanceof PreparedButlerResourceError) {
          adapterResult = gatedAdapterResult("measurement_unavailable", boundedPreparedResourceCode(error.code), adapterVersion);
        } else {
          if (input.fixture.m1V2) {
            adapterResult = gatedAdapterResult("measurement_unavailable", "Butler M1 product-path evidence was unavailable after harness failure.", adapterVersion);
          } else throw error;
        }
      }
      const failure = projectButlerAdapterFailure(evidence);
      if (runnerError instanceof PreparedButlerResourceError && !failure) {
        adapterResult = gatedAdapterResult(
          "measurement_unavailable",
          boundedPreparedResourceCode(runnerError.code),
          adapterVersion,
        );
      }
      try {
        try {
          const infrastructureGate = input.fixture.m1V2 ? butlerM1V2InfrastructureGate(evidence) : null;
          if (infrastructureGate) {
            adapterResult = gatedAdapterResult(infrastructureGate.code, infrastructureGate.diagnostic, adapterVersion);
          }
          if (input.fixture.id === "butler_landing_page") {
            const run = asRecord(evidence.run);
            const workspaceRoot = typeof run?.workspaceRoot === "string" ? run.workspaceRoot : null;
            if (!workspaceRoot || !input.sourceEvidenceRoot) {
              adapterResult = gatedAdapterResult("configuration_unverifiable", "Butler landing workspace did not expose the pinned evidence root.", adapterVersion);
            } else if (rootsOverlap(workspaceRoot, input.arm.outputRoot)) {
              adapterResult = gatedAdapterResult("configuration_unverifiable", "Butler evidence workspace overlaps the generated output workspace.", adapterVersion);
            } else {
              const evidenceCheck = verifyEvidenceWorkspace(
                { root: input.sourceEvidenceRoot, files: readRepositoryEvidenceFiles(input.sourceEvidenceRoot).map((file) => file.path.replace(/^\.benchmark-input\/repository\//u, "")), sha256: "" },
                workspaceRoot,
              );
              if (!evidenceCheck.ok) {
                adapterResult = gatedAdapterResult("configuration_unverifiable", evidenceCheck.diagnostic ?? "Butler workspace repository evidence verification failed.", adapterVersion);
              }
            }
          }
          if (!adapterResult) {
            copyGeneratedArtifacts(evidence, input);
            adapterResult = { ...parseButlerEvidence(evidence, startedAtMs, Date.now(), input), adapterVersion };
            adapterResult.providerDispatchState = providerDispatchState(evidence);
            if (input.fixture.m1V2 && evidence.kind !== "launch_smoke") {
              try {
                adapterResult.m1V2Evidence = await collectButlerM1V2Evidence({ benchmark: input, evidence, attemptStartedAtMs: startedAtMs });
                adapterResult.evidenceRefs = [
                  ...adapterResult.evidenceRefs,
                  adapterResult.m1V2Evidence.exportHandle!,
                  ...(adapterResult.m1V2Evidence.activationReceiptHandle
                    ? [adapterResult.m1V2Evidence.activationReceiptHandle]
                    : []),
                ];
              } catch (_error) {
                adapterResult = { ...adapterResult, gateCode: "measurement_unavailable",
                  stderr: boundedDiagnostic(adapterResult.stderr, "sc01_durable_evidence_export_failed"), m1V2Evidence: undefined };
              }
            }
          }
        } catch (error) {
          if (!failure) throw error;
          adapterResult = gatedAdapterResult(
            "measurement_unavailable",
            "Butler Electron harness failure evidence could not be parsed.",
            adapterVersion,
          );
        }
        if (adapterResult && failure) {
          const { providerDispatchState: _unverifiedDispatchState, ...resultWithoutDispatchState } = adapterResult;
          adapterResult = {
            ...resultWithoutDispatchState,
            failure,
            ...(failure.providerDispatchState
              ? { providerDispatchState: failure.providerDispatchState }
              : {}),
          };
        }
      } finally {
        const rawEvidenceRemoved = !input.fixture.m1V2 ||
          removeRawButlerHarnessEvidence(input.arm.evidenceRoot);
        const durableExport = !input.fixture.m1V2
          ? "not_armed"
          : adapterResult?.m1V2Evidence?.exportSha256
          ? "verified"
          : "privacy_failed_arm";
        const cleanup = cleanupButlerRuntime(evidence, input.arm, durableExport);
        const verifiedTypedFiles = new Set<string>();
        if (adapterResult?.m1V2Evidence?.exportSha256) verifiedTypedFiles.add("sc01-public-evidence.json");
        if (adapterResult?.m1V2Evidence?.activationReceipt?.identitySha256) {
          verifiedTypedFiles.add("m1-v2-runtime-activation-receipt.json");
        }
        const privateCorpusRemoved = !input.fixture.m1V2 ||
          prunePrivateButlerEvidenceCorpus(input.arm.evidenceRoot, verifiedTypedFiles);
        if (adapterResult && input.fixture.m1V2) {
          const typedHandles = new Set([
            adapterResult.m1V2Evidence?.exportHandle,
            adapterResult.m1V2Evidence?.activationReceiptHandle,
          ].filter((value): value is string => Boolean(value)));
          adapterResult = { ...adapterResult,
            evidenceRefs: adapterResult.evidenceRefs.filter((value) => typedHandles.has(value)) };
        }
        if (adapterResult && (cleanup.status === "unsafe" || cleanup.status === "failed")) {
          const productFailure = adapterResult.exitCode !== 0 || adapterResult.timedOut || adapterResult.cancelled || evidence.error !== undefined || evidence.ok === false;
          const postDispatch = adapterResult.providerDispatchState === "provider_dispatched" || adapterResult.providerDispatchState === "provider_output_observed";
          if (!productFailure && (cleanup.reason === "durable_export_required" || postDispatch)) {
            adapterResult = { ...adapterResult, gateCode: "measurement_unavailable",
              stderr: boundedDiagnostic(adapterResult.stderr, cleanup.diagnostic ?? "Butler runtime cleanup could not be verified.") };
          } else if (!productFailure) {
            adapterResult = gatedAdapterResult("configuration_unverifiable", cleanup.diagnostic ?? "Butler runtime cleanup could not be verified.", adapterVersion);
          }
        }
        if (adapterResult && !rawEvidenceRemoved) {
          adapterResult = { ...adapterResult, gateCode: "measurement_unavailable",
            stderr: boundedDiagnostic(adapterResult.stderr, "raw_harness_evidence_retention_failed") };
        }
        if (adapterResult && !privateCorpusRemoved) {
          adapterResult = { ...adapterResult, gateCode: "measurement_unavailable",
            stderr: boundedDiagnostic(adapterResult.stderr, "private_evidence_corpus_retention_failed") };
        }
      }
      if (!adapterResult) throw new Error("Butler adapter did not produce a structured result.");
      return adapterResult;
    },
  };
}

function providerDispatchState(evidence: Record<string, unknown>): "adapter_entered" | "provider_dispatched" | "provider_output_observed" {
  const requests = Array.isArray(evidence.providerRequests) ? evidence.providerRequests.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : [];
  if (requests.some((row) => row.hasTextContent === true || row.hasToolArgumentContent === true || row.hasReasoningContent === true ||
      typeof row.firstContentBearingDeltaAtMs === "number")) return "provider_output_observed";
  return requests.length > 0 ? "provider_dispatched" : "adapter_entered";
}

function boundedDiagnostic(current: string, diagnostic: string): string {
  return [current.trim(), diagnostic].filter(Boolean).join("\n").slice(-2_000);
}

function boundedPreparedResourceCode(value: string): string {
  return /^[a-z][a-z0-9_]{0,119}$/u.test(value) ? value : "prepared_resource_unavailable";
}

export function createElectronButlerRunner(
  preparedResource?: PreparedButlerResourceReference,
  options: {
    rendererStartSmoke?: boolean;
    pairedPreparedButlerResources?: Readonly<Record<"before" | "after", PreparedButlerResourceReference>>;
    pairedExecution?: import("./paired-contract.ts").PairedExecutionContract;
  } = {},
): ButlerBenchmarkRunner {
  return (input): Promise<Record<string, unknown>> => withPreparedButlerResource({
      reference: input.arm.version
        ? options.pairedPreparedButlerResources
          ? options.pairedPreparedButlerResources[input.arm.version]
          : preparedResource
        : preparedResource,
      sourceRoot: input.arm.sourceRoot,
      sourceRevision: input.arm.sourceRevision,
    }, async (preparedResourceOptions) => {
      const scenario: ElectronScenario = input.fixture.m1V2
        ? structuredClone(input.fixture.m1V2.scenario)
        : {
            schema: "butler.btcc-r3-electron-scenario.v1",
            id: `agent-benchmark-${input.arm.cachePairId}`,
            model: input.arm.effectiveConfig.model ?? undefined,
            reasoningEffort: electronReasoning(input.arm.effectiveConfig.reasoning),
            accessMode: "full_access",
            session: {
              id: randomUUID(),
              kind: input.fixture.id === "butler_landing_page" ? "project" : "chat",
              projectDisplayName: input.fixture.id === "butler_landing_page" ? "Butler benchmark landing page" : undefined,
              title: `Agent benchmark ${input.fixture.id}`,
            },
            fixtures: input.fixture.id === "butler_landing_page"
              ? readRepositoryEvidenceFiles(input.sourceEvidenceRoot)
              : [],
            steps: input.fixture.prompts.map((prompt, index) => ({
              id: `turn-${index + 1}`,
              prompt: `${prompt}\n\n${input.runtimeInstructions}`,
              timeoutMs: input.arm.timeoutMs,
              reloadAfter: index === input.fixture.prompts.length - 1,
              expect: { terminalState: "delivered" },
            })),
          };
      scenario.id = `agent-benchmark-${input.arm.key.replaceAll(":", "-")}`;
      if (scenario.session) scenario.session.id = scenario.id;
      if (options.rendererStartSmoke === true) {
        scenario.providerFixture = { responses: [] };
      }
      return withButlerM1V2Environment(input, () => runBtccR3ElectronHarness(scenario, {
        repoRoot: input.arm.sourceRoot,
        runRoot: input.arm.evidenceRoot,
        model: input.arm.effectiveConfig.model ?? undefined,
        reasoningEffort: electronReasoning(input.arm.effectiveConfig.reasoning),
        accessMode: "full_access",
        keepLogs: true,
        smoke: options.rendererStartSmoke === true,
        ...preparedResourceOptions,
        promptCacheKeyPrefix: promptCacheKeyPrefixForPair(input.arm.cachePairId),
        ...(input.arm.version && options.pairedExecution ? { pairedExecution: {
          model: options.pairedExecution.model,
          reasoning: options.pairedExecution.reasoning,
          serviceTier: options.pairedExecution.serviceTier,
          authMode: options.pairedExecution.authMode,
        } } : {}),
      }));
    });
}

function parseButlerEvidence(
  evidence: Record<string, unknown>,
  startedAtMs: number,
  endedAtMs: number,
  input: AdapterRunInput,
): AdapterRunResult {
  const observations = Array.isArray(evidence.observations) ? evidence.observations : [];
  const finalObservation = asRecord(observations.at(-1));
  const firstObservation = asRecord(observations[0]);
  const finalText = typeof finalObservation?.finalText === "string" ? finalObservation.finalText : null;
  const changedPaths = observations.flatMap((value) => {
    const artifacts = asRecord(asRecord(value)?.artifacts);
    return Object.values(artifacts ?? {}).flatMap((entry) => {
      const path = asRecord(entry)?.path;
      return typeof path === "string" ? [relative(input.arm.sourceRoot, path)] : [];
    });
  });
  const run = asRecord(evidence.run);
  const session = asRecord(evidence.session);
  const dataRoot = typeof run?.dataRoot === "string" ? run.dataRoot : null;
  const model = typeof finalObservation?.providerReportedModel === "string"
    ? finalObservation.providerReportedModel
    : null;
  const terminalTiming = asRecord(finalObservation?.timing);
  const firstTiming = asRecord(firstObservation?.timing);
  const terminalAtMs = numberOrNull(terminalTiming?.terminalAtMs) ?? endedAtMs;
  const submittedAtMs = numberOrNull(firstTiming?.submittedAtMs) ?? startedAtMs;
  const usage = dataRoot
    ? readProductUsage(dataRoot, syntheticTarget(input.arm.effectiveConfig.model ?? model ?? ""), terminalAtMs)
    : { model: null, modelRequests: null, promptTokens: null, cachedPromptTokens: null, outputTokens: null, totalTokens: null };
  const turnIds = observations.flatMap((value) => {
    const turnId = asRecord(value)?.turnId;
    return typeof turnId === "string" && turnId ? [turnId] : [];
  });
  const turnEvents = dataRoot
    ? turnIds.map((turnId) => readTurnEvents(dataRoot, turnId))
    : [];
  const terminalState = finalObservation?.terminalState === "delivered";
  const toolSummaries = turnEvents.map((events) => summarizeTools(events, terminalState, terminalAtMs));
  const toolRecords = toolSummaries.flatMap((summary) => summary.observations);
  const calls = toolSummaries.reduce((sum, summary) => sum + summary.calls, 0);
  const failedCalls = toolSummaries.reduce((sum, summary) => sum + summary.failedCalls, 0);
  const firstTurnEvents = turnEvents[0] ?? [];
  const firstUsefulOutputAtMs = boundedUsefulTime(
    firstMeaningfulEventTime(firstTurnEvents) ?? numberOrNull(firstTiming?.firstProviderTokenAtMs) ?? null,
    submittedAtMs,
    terminalAtMs,
  );
  const providerRequests = Array.isArray(evidence.providerRequests)
    ? evidence.providerRequests.filter((request): request is Record<string, unknown> => Boolean(asRecord(request)) && asRecord(request)?.requestKind === "agent")
    : [];
  const effectiveModel = normalizeObservedModel(model ?? usage.model, input.arm.effectiveConfig.model);
  const runReasoning = typeof run?.reasoningEffort === "string" ? run.reasoningEffort : "";
  return {
    exitCode: evidence.error || evidence.ok === false ? 1 : 0,
    gateCode: "none",
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: evidence.error || evidence.ok === false ? "Butler Electron harness reported a failed run." : "",
    adapterVersion: "butler-local",
    provider: effectiveModel?.split("/", 1)[0] ?? null,
    finalText,
    ...(effectiveModel ? { effectiveConfig: { model: effectiveModel } } : {}),
    ...(input.arm.version && effectiveModel ? { pairedExecutionEvidence: {
      provider: effectiveModel.split("/", 1)[0] ?? "",
      model: effectiveModel,
      reasoning: runReasoning,
      providerServiceTiers: providerRequests.map((request) =>
        typeof request.providerReportedServiceTier === "string"
          ? request.providerReportedServiceTier
          : null),
      requestServiceTiers: providerRequests.map((request) =>
        request.requestedServiceTierMode === "auto_by_omission" ? "auto_by_omission" :
          typeof request.requestedServiceTier === "string" ? request.requestedServiceTier : null),
      requestModels: providerRequests.map((request) =>
        typeof request.requestedModel === "string" ? normalizeObservedModel(request.requestedModel, input.arm.effectiveConfig.model) : null),
      requestReasoning: providerRequests.map((request) =>
        typeof request.requestedReasoning === "string" ? request.requestedReasoning : null),
      authorizationSchemes: providerRequests.map((request) =>
        typeof request.authorizationScheme === "string" ? request.authorizationScheme : null),
      routeIds: providerRequests.map((request) => typeof request.routeId === "string" ? request.routeId : null),
    } } : {}),
    usage: {
      inputTokens: usage.promptTokens,
      cacheReadTokens: usage.cachedPromptTokens,
      cacheWriteTokens: null,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      modelRequests: providerRequests.length > 0 ? providerRequests.length : usage.modelRequests,
    },
    tools: { calls, failedCalls, records: toolRecords.map((tool) => ({ callId: tool.callId, name: tool.toolName, status: tool.status === "started" ? "unknown" : tool.status, startedAtMs: tool.startedAtMs, endedAtMs: tool.endedAtMs })) },
    timing: {
      submittedAtMs,
      firstUsefulOutputAtMs,
      terminalAtMs,
      totalElapsedMs: Math.max(0, terminalAtMs - submittedAtMs),
    },
    operations: { userInterventions: sumNullable(observations.map((value) => numberOrNull(asRecord(asRecord(value)?.ux)?.userInterventions))) ?? 0, retries: null, changedFiles: changedPaths.length, tests: { ran: null, passed: null, command: null }, build: { ran: null, passed: null, command: null } },
    sessionId: typeof session?.id === "string" ? session.id : null,
    changedPaths,
    evidenceRefs: Array.isArray(finalObservation?.screenshots)
      ? finalObservation.screenshots.filter((value): value is string => typeof value === "string").map((value) => relative(input.arm.evidenceRoot, value)).filter((value) => !value.startsWith(".."))
      : [],
  };
}
function syntheticTarget(model: string): BenchmarkTarget {
  return {
    revision: "r3", worktreePath: "<benchmark-source>",
    commit: "549463fbe074fc25042f9302cd330699948dab50",
    buildId: "agent-benchmark",
    appBaseUrl: "http://127.0.0.1",
    electronDebugPort: 0,
    dataRoot: "<benchmark-data>", electronUserData: "<benchmark-profile>",
    workspaceRoot: "<benchmark-workspace>",
    model, reasoningEffort: "medium", permissionMode: "full_access",
    fixtureHash: "agent-benchmark",
  };
}
function normalizeObservedModel(observed: string | null, requested: string | null): string | null {
  if (!observed) return null;
  if (requested && (observed === requested || requested.endsWith(`/${observed}`))) return requested;
  return observed;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
