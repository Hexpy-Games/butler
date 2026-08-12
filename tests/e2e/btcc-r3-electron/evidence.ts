import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionHintForRow } from
  "../../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import {
  BTCC_R3_ELECTRON_EVIDENCE_SCHEMA,
  type ElectronHarnessOptions,
  type PreparedRun,
  type StepObservation,
} from "./contracts.ts";
import type { ProviderRequestObservation } from
  "./provider-observation-proxy.ts";
import { isInside } from "./scenario-preflight.ts";

export interface LaunchObservation {
  electronPid: number | null;
  executorPid: number | null;
  interruptedExecutorReplaced: boolean;
  startedAtMs: number;
  stoppedAtMs: number | null;
}

export function writeEvidence(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function safeOutputTail(output: string[]): string[] {
  return output
    .join("")
    .split(/\r?\n/u)
    .filter(Boolean)
    .slice(-80)
    .map((line) => line
      .replace(/(?:sk|sess)-[A-Za-z0-9._-]{12,}/gu, "<redacted>")
      .replace(/Bearer\s+\S+/giu, "Bearer <redacted>"));
}

export function successEvidence(input: {
  bindingWorkspace: string | null;
  launches: LaunchObservation[];
  observations: StepObservation[];
  options: ElectronHarnessOptions;
  providerRequests: ProviderRequestObservation[];
  run: PreparedRun;
}): Record<string, unknown> {
  const { bindingWorkspace, launches, observations, options, providerRequests, run } = input;
  const normalizeModel = (value: string): string => {
    const trimmed = value.trim();
    return trimmed.includes("/")
      ? trimmed.slice(trimmed.indexOf("/") + 1)
      : trimmed;
  };
  const allPassed = observations.every((item) =>
    item.expectations.passed &&
    item.reload.finalMatched !== false &&
    item.restart.finalMatched !== false &&
    item.providerReportedModel !== null &&
    item.providerAgentModels.length > 0 &&
    normalizeModel(item.providerReportedModel) ===
      normalizeModel(item.providerAgentModels.at(-1)!),
  );
  const providerPath = run.providerFixtureEnabled
    ? "deterministic_provider_fixture"
    : "real_provider";
  return {
    schema: BTCC_R3_ELECTRON_EVIDENCE_SCHEMA,
    kind: options.smoke ? "launch_smoke" : "scenario_run",
    ok: options.smoke ? true : allPassed,
    actualProductPath: options.smoke
      ? [
        "electron_renderer",
        "electron_preload_bridge",
        "app_gateway",
        "native_btcc_runtime",
      ]
      : [
        "electron_renderer",
        "electron_preload_bridge",
        "app_gateway",
        "native_btcc_runtime",
        providerPath,
        "renderer_visible_final",
        "renderer_visible_ordered_stage_activities",
        "app_database_work_lifecycle",
      ],
    run: {
      accessMode: run.accessMode,
      agentOwnership: run.agentOwnership,
      dataRoot: run.dataRoot,
      debugPort: run.debugPort,
      electronProfile: run.electronProfile,
      model: run.model,
      reasoningEffort: run.reasoningEffort,
      repoRoot: run.repoRoot,
      runId: run.runId,
      runRoot: run.runRoot,
      serverPort: run.serverPort,
      projectWorkspaceRoot: run.projectWorkspaceRoot,
      workspaceRoot: run.workspaceRoot,
    },
    isolation: {
      bindingWorkspace,
      sourceDataReadOnly: run.sourceData,
      sourceDataIsRunData: run.sourceData === run.dataRoot,
      workspaceInsideRunRoot: isInside(run.runRoot, run.workspaceRoot),
    },
    session: {
      id: run.sessionId,
      kind: run.sessionKind,
      projectId: run.projectId,
      runtimeId: sessionHintForRow(run.sessionId),
      title: run.sessionTitle,
    },
    launches,
    observations,
    providerRequests,
    generatedAt: new Date().toISOString(),
    ...(options.bundledAgentResourceIdentity
      ? { bundledAgentResource: { ...options.bundledAgentResourceIdentity } }
      : {}),
  };
}

export function failureEvidence(input: {
  electronOutput?: string[];
  error: unknown;
  executorOutput?: string[];
  launches?: LaunchObservation[];
  observations: StepObservation[];
  options: ElectronHarnessOptions;
  providerRequests: ProviderRequestObservation[];
  run: PreparedRun;
}): Record<string, unknown> {
  const { error, observations, options, run } = input;
  const typedFailure = harnessFailureDetails(error);
  return {
    schema: BTCC_R3_ELECTRON_EVIDENCE_SCHEMA,
    kind: options.smoke ? "launch_smoke" : "scenario_run",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(typedFailure ? { failure: typedFailure } : {}),
    run: {
      agentOwnership: run.agentOwnership,
      dataRoot: run.dataRoot,
      debugPort: run.debugPort,
      electronProfile: run.electronProfile,
      runId: run.runId,
      runRoot: run.runRoot,
      serverPort: run.serverPort,
      workspaceRoot: run.workspaceRoot,
    },
    launches: input.launches ?? [],
    observations,
    providerRequests: input.providerRequests,
    generatedAt: new Date().toISOString(),
    ...(options.bundledAgentResourceIdentity
      ? { bundledAgentResource: { ...options.bundledAgentResourceIdentity } }
      : {}),
    ...(options.keepLogs && input.electronOutput
      ? { sanitizedElectronLogTail: safeOutputTail(input.electronOutput) }
      : {}),
    ...(options.keepLogs && input.executorOutput
      ? { sanitizedExecutorLogTail: safeOutputTail(input.executorOutput) }
      : {}),
  };
}

function harnessFailureDetails(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const failure = (error as { failure?: unknown }).failure;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const candidate = failure as Record<string, unknown>;
  if (
    typeof candidate.stage !== "string" ||
    typeof candidate.cause !== "string" ||
    typeof candidate.owner !== "string" ||
    !(candidate.exitCode === null || typeof candidate.exitCode === "number") ||
    !(candidate.signal === null || typeof candidate.signal === "string")
  ) return null;
  const details: Record<string, unknown> = {
    stage: candidate.stage,
    cause: candidate.cause,
    owner: candidate.owner,
    exitCode: candidate.exitCode,
    signal: candidate.signal,
  };
  for (const key of ["availableBytes", "requiredBytes"] as const) {
    if (candidate[key] === null ||
        typeof candidate[key] === "number" && Number.isSafeInteger(candidate[key])) {
      details[key] = candidate[key];
    }
  }
  if (candidate.portRole === "app_server" || candidate.portRole === "electron_debug") {
    details.portRole = candidate.portRole;
  }
  return details;
}
