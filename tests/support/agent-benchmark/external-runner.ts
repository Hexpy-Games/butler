import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  AdapterRunInput,
  AdapterRunResult,
  EffectiveAgentConfig,
} from "./contracts.ts";
import { commandFor, parseCliOutput } from "./cli-output.ts";
import {
  hermesUsageDiagnosticFor,
  hermesUsagePath,
  readHermesUsage,
} from "./hermes-cli.ts";
import { boundedUsefulTime } from "./external-normalization.ts";
import { controlledOpenCodeEnvironment } from "./opencode-config.ts";
import { sanitizeIdentifier } from "./identifiers.ts";
import { safeEnvironment, type CommandExecutor } from "./command.ts";

export interface ExternalRunContext {
  agent: "hermes" | "opencode";
  executable: string;
  executor: CommandExecutor;
  preflightVersion: string | null;
  preflightModel: string | null;
  preflightConfig: Partial<EffectiveAgentConfig> | null;
  baseEnvironment: NodeJS.ProcessEnv;
  openCodeAuthDataRoot: string | null;
}

/** Executes one external product turn and normalizes bounded typed evidence. */
export async function runExternalTurn(
  context: ExternalRunContext,
  input: AdapterRunInput,
): Promise<AdapterRunResult> {
  const command = commandFor(context.agent, input);
  const usagePath = context.agent === "hermes" && input.fixture.id !== "direct_conversation"
    ? hermesUsagePath(input.arm.evidenceRoot)
    : null;
  if (usagePath) {
    mkdirSync(input.arm.evidenceRoot, { recursive: true });
    if (existsSync(usagePath)) unlinkSync(usagePath);
  }
  const controlledOpenCode = context.agent === "opencode" && input.arm.track === "controlled";
  if (controlledOpenCode) {
    mkdirSync(input.arm.dataRoot, { recursive: true });
    mkdirSync(input.arm.cacheRoot, { recursive: true });
    mkdirSync(join(input.arm.dataRoot, "home"), { recursive: true });
    mkdirSync(join(input.arm.dataRoot, "xdg-config"), { recursive: true });
    mkdirSync(join(input.arm.dataRoot, "opencode-config"), { recursive: true });
  }
  const result = await context.executor.execute({
    executable: context.executable,
    args: command.args,
    cwd: input.arm.outputRoot,
    env: controlledOpenCode
      ? controlledOpenCodeEnvironment(input.arm, context.openCodeAuthDataRoot!, context.baseEnvironment)
      : safeExternalEnvironment(context, input),
    timeoutMs: input.arm.timeoutMs,
    signal: input.signal,
  });
  const outputIncomplete = result.outputComplete === false;
  const parsed = parseCliOutput(context.agent, result.stdout, boundedUsefulTime(result.firstOutputAtMs, result.startedAtMs, result.endedAtMs), result.stderr);
  const hermesUsage = usagePath ? readHermesUsage(usagePath) : null;
  const hermesUsageDiagnostic = usagePath ? hermesUsageDiagnosticFor(hermesUsage) : null;
  const usageFailure = hermesUsage !== null && hermesUsageDiagnostic !== null;
  const missingUsage = hermesUsage === null && hermesUsageDiagnostic !== null;
  const observedModel = hermesUsage?.model ?? parsed.effectiveModel ?? (
    context.agent === "hermes"
      ? input.arm.track === "recommended-default" ? context.preflightModel : null
      : input.arm.track === "controlled" ? input.arm.effectiveConfig.model : context.preflightModel
  );
  const effectiveModel = observedModel
    ? normalizeObservedModel(observedModel, input.arm.effectiveConfig.model)
    : null;
  const effectiveConfig = context.agent === "hermes"
    ? {
        ...(effectiveModel ? { model: effectiveModel } : {}),
        provider: sanitizeIdentifier(hermesUsage?.provider ?? (input.arm.track === "controlled" ? input.arm.effectiveConfig.provider : context.preflightConfig?.provider)) ?? null,
        reasoning: input.arm.track === "controlled"
          ? input.arm.effectiveConfig.reasoning
          : context.preflightConfig?.reasoning ?? null,
        variant: null,
      }
    : effectiveModel
      ? { model: effectiveModel }
      : undefined;
  const usage = hermesUsage
    ? {
        inputTokens: hermesUsage.inputTokens,
        cacheReadTokens: hermesUsage.cacheReadTokens,
        cacheWriteTokens: hermesUsage.cacheWriteTokens,
        outputTokens: hermesUsage.outputTokens,
        totalTokens: hermesUsage.totalTokens,
        modelRequests: hermesUsage.apiCalls,
      }
    : parsed.usage;
  const sessionId = context.agent === "hermes"
    ? usagePath ? hermesUsage?.sessionId ?? null : parsed.sessionId
    : parsed.sessionId;
  const exitCode = usageFailure && result.exitCode === 0 ? 1 : result.exitCode;
  const gateCode = outputIncomplete && result.exitCode === 0 && !result.timedOut && !result.cancelled
    ? "measurement_unavailable"
    : usagePath && missingUsage && result.exitCode === 0 && !result.timedOut && !result.cancelled
    ? "measurement_unavailable"
    : result.exitCode !== 0 || result.timedOut || result.cancelled || result.exitCode === null
      ? "none"
      : parsed.gateCode;
  const stderr = outputIncomplete
    ? `${result.stderr}\nCommand output stream completeness was not established.`.trim()
    : hermesUsageDiagnostic
    ? usageFailure || result.exitCode === 0
      ? hermesUsageDiagnostic
      : `${result.stderr}\n${hermesUsageDiagnostic}`.trim()
    : result.stderr;
  return {
    exitCode,
    gateCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    stdout: result.stdout,
    stderr,
    adapterVersion: context.preflightVersion,
    provider: sanitizeIdentifier(hermesUsage?.provider) ?? null,
    finalText: parsed.finalText,
    sessionId,
    ...(effectiveConfig ? { effectiveConfig } : {}),
    usage,
    tools: parsed.tools,
    timing: { submittedAtMs: result.startedAtMs, firstUsefulOutputAtMs: parsed.firstUsefulOutputAtMs, terminalAtMs: result.endedAtMs, totalElapsedMs: result.endedAtMs - result.startedAtMs },
    operations: { userInterventions: 0, retries: null, changedFiles: parsed.changedPaths.length, tests: { ran: null, passed: null, command: null }, build: { ran: null, passed: null, command: null } },
    changedPaths: parsed.changedPaths,
    evidenceRefs: [],
  };
}

function safeExternalEnvironment(context: ExternalRunContext, input: AdapterRunInput): NodeJS.ProcessEnv {
  const extra: NodeJS.ProcessEnv = {
    ...(context.agent === "opencode" && input.arm.effectiveConfig.model ? { OPENCODE_MODEL: input.arm.effectiveConfig.model } : {}),
    XDG_CACHE_HOME: join(input.arm.cacheRoot, "xdg-cache"),
    ...(context.agent === "hermes" ? { HERMES_WRITE_SAFE_ROOT: input.arm.outputRoot } : {}),
  };
  return safeEnvironment(extra, context.baseEnvironment);
}

function normalizeObservedModel(observed: string, requested: string | null): string {
  return requested && (observed === requested || requested.endsWith(`/${observed}`)) ? requested : observed;
}
