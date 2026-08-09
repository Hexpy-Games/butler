import type {
  AdapterRunInput,
  AdapterRunResult,
  AgentAdapter,
  EffectiveAgentConfig,
  PreflightResult,
} from "./contracts.ts";
import { createProcessExecutor, resolveExecutable, safeEnvironment, type CommandExecutor } from "./command.ts";
import { readHermesSessionTelemetry } from "./hermes-cli.ts";
import { benchmarkPlatformGate } from "./isolation.ts";
import { sanitizeIdentifier } from "./identifiers.ts";
import { resolveOpenCodeAuthDataRoot } from "./opencode-config.ts";
import { runExternalTurn } from "./external-runner.ts";
import {
  authListingIsPositive,
  combineExternalRuns,
  emptyAdapterResult,
  firstLine,
  hermesAuthFilesExist,
  resolveHermesConfig,
  safeVersion,
} from "./external-normalization.ts";

export class ExternalCliAdapter implements AgentAdapter {
  readonly agent: "hermes" | "opencode";
  private readonly executor: CommandExecutor;
  private executablePath: string | null = null;
  private preflightVersion: string | null = null;
  private preflightModel: string | null = null;
  private preflightConfig: Partial<EffectiveAgentConfig> | null = null;
  private readonly baseEnvironment: NodeJS.ProcessEnv;
  private openCodeAuthDataRoot: string | null = null;
  private openCodeAuthRootChecked = false;

  constructor(agent: "hermes" | "opencode", executor: CommandExecutor) {
    this.agent = agent;
    this.executor = executor;
    this.baseEnvironment = { ...process.env };
  }

  async preflight(): Promise<PreflightResult> {
    const platformDiagnostic = benchmarkPlatformGate();
    if (platformDiagnostic) {
      return {
        available: false,
        executable: null,
        version: null,
        authenticated: null,
        configVerified: false,
        gateCode: "configuration_unverifiable",
        diagnostic: platformDiagnostic,
      };
    }
    this.executablePath = resolveExecutable(this.agent);
    if (!this.executablePath) {
      return {
        available: false,
        executable: null,
        version: null,
        authenticated: null,
        configVerified: false,
        gateCode: "executable_missing",
        diagnostic: `${this.agent} executable is not installed on PATH.`,
      };
    }
    if (this.agent === "opencode" && !this.ensureOpenCodeAuthDataRoot()) {
      return {
        available: false,
        executable: this.executablePath,
        version: null,
        authenticated: null,
        configVerified: false,
        gateCode: "configuration_unverifiable",
        diagnostic: "OpenCode authentication data root could not be verified.",
      };
    }
    const versionResult = await this.executor.execute({
      executable: this.executablePath,
      args: ["--version"],
      cwd: process.cwd(),
      env: safeEnvironment({}, this.baseEnvironment),
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    if (versionResult.exitCode !== 0 || versionResult.timedOut) {
      return {
        available: false,
        executable: this.executablePath,
        version: null,
        authenticated: null,
        configVerified: false,
        gateCode: "configuration_unverifiable",
        diagnostic: `${this.agent} version probe failed.`,
      };
    }
    const authResult = await this.executor.execute({
      executable: this.executablePath,
      args: ["auth", "list"],
      cwd: process.cwd(),
      env: safeEnvironment({}, this.baseEnvironment),
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    const version = safeVersion(firstLine(versionResult.stdout) || firstLine(versionResult.stderr));
    this.preflightVersion = version;
    const authenticated = authResult.exitCode === 0 && authListingIsPositive(authResult.stdout, this.agent) &&
      (this.agent !== "hermes" || hermesAuthFilesExist());
    const effectiveConfig = this.agent === "hermes"
      ? await resolveHermesConfig(this.executablePath, this.executor)
      : process.env.OPENCODE_MODEL ? { model: sanitizeIdentifier(process.env.OPENCODE_MODEL) } : null;
    this.preflightConfig = effectiveConfig;
    this.preflightModel = effectiveConfig?.model ?? null;
    return {
      available: authenticated,
      executable: this.executablePath,
      version,
      authenticated,
      configVerified: authenticated,
      gateCode: authenticated ? "none" : "authentication_unavailable",
      diagnostic: authenticated ? null : `${this.agent} authentication/configuration is unavailable.`,
      ...(effectiveConfig ? { effectiveConfig } : {}),
    };
  }

  async run(input: AdapterRunInput): Promise<AdapterRunResult> {
    if (benchmarkPlatformGate()) return emptyAdapterResult("configuration_unverifiable", benchmarkPlatformGate()!);
    const executable = this.executablePath ?? resolveExecutable(this.agent);
    if (!executable) return emptyAdapterResult();
    if (this.agent === "opencode" && !this.ensureOpenCodeAuthDataRoot()) {
      return emptyAdapterResult("configuration_unverifiable", "OpenCode authentication data root could not be verified.");
    }
    const prompts = input.fixture.id === "direct_conversation" ? input.fixture.prompts : [input.prompt];
    const runs: AdapterRunResult[] = [];
    let sessionId: string | null = null;
    for (const [index, prompt] of prompts.entries()) {
      const turnInput: AdapterRunInput = {
        ...input,
        prompt: `${prompt}\n\n${input.runtimeInstructions}`,
        sessionId,
      };
      runs.push(await runExternalTurn({
        agent: this.agent,
        executable,
        executor: this.executor,
        preflightVersion: this.preflightVersion,
        preflightModel: this.preflightModel,
        preflightConfig: this.preflightConfig,
        baseEnvironment: this.baseEnvironment,
        openCodeAuthDataRoot: this.openCodeAuthDataRoot,
      }, turnInput));
      const lastRun = runs.at(-1)!;
      // Preserve real product failures before applying measurement gates for
      // missing session telemetry. A failed turn cannot be repaired by a
      // later session-id probe.
      if (lastRun.exitCode !== 0 || lastRun.timedOut || lastRun.cancelled || input.signal.aborted) break;
      const observedSessionId = lastRun.sessionId ?? null;
      if (input.fixture.id === "direct_conversation" && index > 0 && observedSessionId !== sessionId) {
        runs.push({ ...emptyAdapterResult(), gateCode: "measurement_unavailable", stderr: "The product changed the real direct-conversation session while resuming a turn." });
        break;
      }
      sessionId = observedSessionId;
      if (input.fixture.id === "direct_conversation" && index < prompts.length - 1 && !sessionId) {
        runs.push({ ...emptyAdapterResult(), gateCode: "measurement_unavailable", stderr: "A real product session id was not observable after the direct-conversation turn." });
        break;
      }
    }
    const combined = combineExternalRuns(runs);
    if (this.agent !== "hermes" || input.fixture.id !== "direct_conversation") return combined;
    const telemetry = readHermesSessionTelemetry(sessionId);
    if (!telemetry) {
      return {
        ...combined,
        gateCode: combined.exitCode === 0 && !combined.timedOut && !combined.cancelled && combined.gateCode === "none"
          ? "measurement_unavailable"
          : combined.gateCode,
        stderr: `${combined.stderr}\nHermes aggregate session telemetry was unavailable.`.trim(),
        usage: {
          inputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          outputTokens: null,
          totalTokens: null,
          modelRequests: null,
        },
        tools: { calls: null, failedCalls: null, records: [] },
      };
    }
    const effectiveModel = telemetry.model
      ? normalizeObservedModel(telemetry.model, input.arm.effectiveConfig.model)
      : null;
    return {
      ...combined,
      sessionId: telemetry.sessionId,
      provider: telemetry.provider,
      effectiveConfig: {
        model: effectiveModel,
        provider: telemetry.provider,
        reasoning: input.arm.track === "controlled" ? input.arm.effectiveConfig.reasoning : this.preflightConfig?.reasoning ?? null,
        variant: null,
      },
      usage: telemetry.usage,
      tools: telemetry.tools,
    };
  }

  private ensureOpenCodeAuthDataRoot(): string | null {
    if (!this.openCodeAuthRootChecked) {
      this.openCodeAuthDataRoot = resolveOpenCodeAuthDataRoot(this.baseEnvironment);
      this.openCodeAuthRootChecked = true;
    }
    return this.openCodeAuthDataRoot;
  }
}

function normalizeObservedModel(observed: string, requested: string | null): string {
  return requested && (observed === requested || requested.endsWith(`/${observed}`)) ? requested : observed;
}

export function createExternalAdapters(executor: CommandExecutor = createProcessExecutor()): {
  hermes: AgentAdapter;
  opencode: AgentAdapter;
} {
  return { hermes: new ExternalCliAdapter("hermes", executor), opencode: new ExternalCliAdapter("opencode", executor) };
}
