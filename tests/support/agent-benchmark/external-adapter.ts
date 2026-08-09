import { join } from "node:path";
import type {
  AdapterRunInput,
  AdapterRunResult,
  AgentAdapter,
  PreflightResult,
} from "./contracts.ts";
import { createProcessExecutor, resolveExecutable, safeEnvironment, type CommandExecutor } from "./command.ts";
import { commandFor, parseCliOutput } from "./cli-output.ts";
import { benchmarkPlatformGate } from "./isolation.ts";
import {
  authListingIsPositive,
  boundedUsefulTime,
  combineExternalRuns,
  emptyAdapterResult,
  firstLine,
  hermesAuthFilesExist,
  safeVersion,
} from "./external-normalization.ts";

const CONTROLLED_OPENCODE_CONFIG = {
  "$schema": "https://opencode.ai/config.json",
  permission: {
    "*": "deny",
    read: "allow",
    edit: { "*": "allow", ".benchmark-input/repository/**": "deny" },
    glob: "allow",
    grep: "allow",
    list: "allow",
    webfetch: "allow",
    websearch: "allow",
    bash: "deny",
    task: "deny",
    skill: "deny",
    question: "deny",
    external_directory: "deny",
    lsp: "deny",
  },
  plugin: [],
  instructions: [],
} as const;

export class ExternalCliAdapter implements AgentAdapter {
  readonly agent: "hermes" | "opencode";
  private readonly executor: CommandExecutor;
  private executablePath: string | null = null;
  private preflightVersion: string | null = null;
  private preflightModel: string | null = null;

  constructor(agent: "hermes" | "opencode", executor: CommandExecutor) {
    this.agent = agent;
    this.executor = executor;
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
    const versionResult = await this.executor.execute({
      executable: this.executablePath,
      args: ["--version"],
      cwd: process.cwd(),
      env: safeEnvironment(),
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
      env: safeEnvironment(),
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    const version = safeVersion(firstLine(versionResult.stdout) || firstLine(versionResult.stderr));
    this.preflightVersion = version;
    const authenticated = authResult.exitCode === 0 && authListingIsPositive(authResult.stdout, this.agent) &&
      (this.agent !== "hermes" || hermesAuthFilesExist());
    const effectiveModel = this.agent === "hermes" ? await this.resolveHermesModel() : process.env.OPENCODE_MODEL ?? null;
    this.preflightModel = effectiveModel;
    return {
      available: authenticated,
      executable: this.executablePath,
      version,
      authenticated,
      configVerified: authenticated,
      gateCode: authenticated ? "none" : "authentication_unavailable",
      diagnostic: authenticated ? null : `${this.agent} authentication/configuration is unavailable.`,
      ...(effectiveModel ? { effectiveConfig: { model: effectiveModel } } : {}),
    };
  }

  private async resolveHermesModel(): Promise<string | null> {
    if (!this.executablePath) return null;
    const result = await this.executor.execute({
      executable: this.executablePath,
      args: ["config", "get", "model"],
      cwd: process.cwd(),
      env: safeEnvironment(),
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    return result.exitCode === 0 ? firstLine(result.stdout) || null : null;
  }

  async run(input: AdapterRunInput): Promise<AdapterRunResult> {
    if (benchmarkPlatformGate()) return emptyAdapterResult("configuration_unverifiable", benchmarkPlatformGate()!);
    const executable = this.executablePath ?? resolveExecutable(this.agent);
    if (!executable) return emptyAdapterResult();
    const prompts = input.fixture.id === "direct_conversation" ? input.fixture.prompts : [input.prompt];
    const runs: AdapterRunResult[] = [];
    let sessionId: string | null = null;
    for (const [index, prompt] of prompts.entries()) {
      const turnInput: AdapterRunInput = {
        ...input,
        prompt: `${prompt}\n\n${input.runtimeInstructions}`,
        sessionId,
      };
      runs.push(await this.runOne(executable, turnInput));
      const observedSessionId = runs.at(-1)?.sessionId ?? null;
      if (input.fixture.id === "direct_conversation" && index > 0 && observedSessionId !== sessionId) {
        runs.push({ ...emptyAdapterResult(), gateCode: "measurement_unavailable", stderr: "The product changed the real direct-conversation session while resuming a turn." });
        break;
      }
      sessionId = observedSessionId;
      if (input.fixture.id === "direct_conversation" && index < prompts.length - 1 && !sessionId) {
        runs.push({ ...emptyAdapterResult(), gateCode: "measurement_unavailable", stderr: "A real product session id was not observable after the direct-conversation turn." });
        break;
      }
      if (runs.at(-1)?.exitCode !== 0 || input.signal.aborted) break;
    }
    return combineExternalRuns(runs);
  }

  private async runOne(executable: string, input: AdapterRunInput): Promise<AdapterRunResult> {
    const command = commandFor(this.agent, input);
    const result = await this.executor.execute({
      executable,
      args: command.args,
      cwd: input.arm.outputRoot,
      env: safeEnvironment({
        ...(this.agent === "opencode" && input.arm.effectiveConfig.model ? { OPENCODE_MODEL: input.arm.effectiveConfig.model } : {}),
        XDG_CACHE_HOME: join(input.arm.cacheRoot, "xdg-cache"),
        ...(this.agent === "hermes"
          ? { HERMES_WRITE_SAFE_ROOT: input.arm.outputRoot }
          : input.arm.track === "controlled" ? {
              XDG_CONFIG_HOME: join(input.arm.cacheRoot, "xdg-config"),
              OPENCODE_CONFIG_DIR: join(input.arm.cacheRoot, "opencode-config"),
              OPENCODE_CONFIG_CONTENT: JSON.stringify(CONTROLLED_OPENCODE_CONFIG),
              OPENCODE_DISABLE_CLAUDE_CODE: "1",
            } : {}),
      }),
      timeoutMs: input.arm.timeoutMs,
      signal: input.signal,
    });
    const parsed = parseCliOutput(this.agent, result.stdout, boundedUsefulTime(result.firstOutputAtMs, result.startedAtMs, result.endedAtMs));
    return {
      exitCode: result.exitCode,
      gateCode: parsed.gateCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdout: result.stdout,
      stderr: result.stderr,
      adapterVersion: this.preflightVersion,
      provider: null,
      finalText: parsed.finalText,
      sessionId: parsed.sessionId,
      ...((parsed.effectiveModel ?? (input.arm.track === "controlled" ? input.arm.effectiveConfig.model : this.preflightModel))
        ? { effectiveConfig: { model: normalizeObservedModel(parsed.effectiveModel ?? (input.arm.track === "controlled" ? input.arm.effectiveConfig.model : this.preflightModel)!, input.arm.effectiveConfig.model) } }
        : {}),
      usage: parsed.usage,
      tools: parsed.tools,
      timing: { submittedAtMs: result.startedAtMs, firstUsefulOutputAtMs: parsed.firstUsefulOutputAtMs, terminalAtMs: result.endedAtMs, totalElapsedMs: result.endedAtMs - result.startedAtMs },
      operations: { userInterventions: 0, retries: null, changedFiles: parsed.changedPaths.length, tests: { ran: null, passed: null, command: null }, build: { ran: null, passed: null, command: null } },
      changedPaths: parsed.changedPaths,
      evidenceRefs: [],
    };
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
