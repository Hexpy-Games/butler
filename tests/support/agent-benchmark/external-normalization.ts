import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AdapterRunResult,
  EffectiveAgentConfig,
  TokenUsage,
  ToolCallObservation,
  ToolMetrics,
} from "./contracts.ts";
import { safeEnvironment, type CommandExecutor } from "./command.ts";
import { sanitizeEffectiveConfig, sanitizeIdentifier } from "./identifiers.ts";

/** Normalizes multi-turn CLI observations without inventing missing metrics. */
export function combineExternalRuns(runs: readonly AdapterRunResult[]): AdapterRunResult {
  const first = runs[0];
  if (!first) return emptyAdapterResult();
  const usage = {
    inputTokens: sumKnown(runs.map((run) => run.usage.inputTokens)),
    cacheReadTokens: sumKnown(runs.map((run) => run.usage.cacheReadTokens)),
    cacheWriteTokens: sumKnown(runs.map((run) => run.usage.cacheWriteTokens)),
    outputTokens: sumKnown(runs.map((run) => run.usage.outputTokens)),
    totalTokens: sumKnown(runs.map((run) => run.usage.totalTokens)),
    modelRequests: sumKnown(runs.map((run) => run.usage.modelRequests)),
  };
  const records = dedupeToolRecords(runs.flatMap((run) => run.tools.records ?? []));
  const calls = runs.some((run) => run.tools.calls === null || run.tools.calls === undefined)
    ? null
    : runs.reduce((sum, run) => sum + (run.tools.calls ?? 0), 0);
  const failedCalls = runs.some((run) => run.tools.failedCalls === null || run.tools.failedCalls === undefined)
    ? null
    : runs.reduce((sum, run) => sum + (run.tools.failedCalls ?? 0), 0);
  const last = runs.at(-1)!;
  return {
    ...last,
    exitCode: runs.some((run) => run.exitCode !== 0) ? runs.find((run) => run.exitCode !== 0)?.exitCode ?? null : 0,
    gateCode: runs.find((run) => run.gateCode !== "none")?.gateCode ?? "none",
    timedOut: runs.some((run) => run.timedOut),
    cancelled: runs.some((run) => run.cancelled),
    stdout: runs.map((run) => run.stdout).join("\n"),
    stderr: runs.map((run) => run.stderr).join("\n"),
    finalText: last.finalText,
    sessionId: last.sessionId,
    ...(runs.find((run) => run.effectiveConfig?.model)?.effectiveConfig ? { effectiveConfig: runs.find((run) => run.effectiveConfig?.model)?.effectiveConfig } : {}),
    usage,
    tools: { calls, failedCalls, records },
    timing: {
      submittedAtMs: first.timing.submittedAtMs ?? null,
      firstUsefulOutputAtMs: runs.map((run) => run.timing.firstUsefulOutputAtMs).find((value): value is number => typeof value === "number") ?? null,
      terminalAtMs: last.timing.terminalAtMs ?? null,
      totalElapsedMs: (typeof first.timing.submittedAtMs === "number" && typeof last.timing.terminalAtMs === "number") ? last.timing.terminalAtMs - first.timing.submittedAtMs : null,
    },
    operations: {
      ...last.operations,
      userInterventions: 0,
      changedFiles: runs.reduce((sum, run) => sum + (run.operations.changedFiles ?? 0), 0),
    },
    changedPaths: [...new Set(runs.flatMap((run) => run.changedPaths))],
  };
}

export function emptyAdapterResult(
  gateCode: AdapterRunResult["gateCode"] = "measurement_unavailable",
  diagnostic = "",
): AdapterRunResult {
  return {
    exitCode: null,
    gateCode,
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: diagnostic,
    adapterVersion: null,
    provider: null,
    finalText: null,
    sessionId: null,
    usage: {} satisfies Partial<TokenUsage>,
    tools: { calls: null, failedCalls: null, records: [] } satisfies Partial<ToolMetrics>,
    timing: {},
    operations: {},
    changedPaths: [],
    evidenceRefs: [],
  };
}

/** Hermes exposes the model object and reasoning scalar through separate
 * `config get ... --json` probes. Keep this preflight authority in the
 * external normalization boundary so the adapter's run path stays one-way. */
export async function resolveHermesConfig(
  executable: string,
  executor: CommandExecutor,
): Promise<Partial<EffectiveAgentConfig> | null> {
  const modelResult = await executor.execute({
    executable,
    args: ["config", "get", "model", "--json"],
    cwd: process.cwd(),
    env: safeEnvironment(),
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  if (modelResult.exitCode !== 0) return null;
  const modelValue = parseJsonValue(modelResult.stdout);
  const modelRecord = asRecord(modelValue);
  const modelConfig = asRecord(modelRecord?.model) ?? modelRecord;
  const reasoningResult = await executor.execute({
    executable,
    args: ["config", "get", "agent.reasoning_effort", "--json"],
    cwd: process.cwd(),
    env: safeEnvironment(),
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  const reasoningValue = reasoningResult.exitCode === 0 ? parseJsonValue(reasoningResult.stdout) : null;
  const reasoningRecord = asRecord(reasoningValue);
  const config = sanitizeEffectiveConfig({
    model: modelConfig ? sanitizeIdentifier(modelConfig.default) : null,
    provider: modelConfig ? sanitizeIdentifier(modelConfig.provider) : null,
    reasoning: sanitizeIdentifier(typeof reasoningValue === "string" ? reasoningValue : reasoningRecord?.value),
  });
  return config.model || config.provider || config.reasoning ? config : null;
}

export function authListingIsPositive(output: string, agent: "hermes" | "opencode"): boolean {
  const normalized = output.trim().toLowerCase();
  if (!normalized || /(?:no credentials?|not configured|not authenticated|no providers?|none configured|logged out|unauthenticated)/u.test(normalized)) return false;
  const positive = agent === "hermes"
    ? /(?:configured|authenticated|logged in|oauth|api key|nous|openrouter|anthropic|openai)/u
    : /(?:configured|authenticated|connected|provider|account|oauth|api key|openai|anthropic|google|openrouter)/u;
  return positive.test(normalized);
}

export function hermesAuthFilesExist(): boolean {
  const home = process.env.HOME;
  if (!home) return false;
  return ["config.yaml", "auth.json", ".env"].some((file) => existsSync(join(home, ".hermes", file)));
}

export function firstLine(value: string): string {
  return value.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
}

export function safeVersion(value: string): string | null {
  if (!value || /(?:api[_-]?key|token|password|secret|\/Users\/|\/home\/|[A-Z]:\\)/iu.test(value)) return null;
  return value.slice(0, 160);
}

export function boundedUsefulTime(value: number | null, submittedAtMs: number, terminalAtMs: number): number | null {
  return typeof value === "number" && value >= submittedAtMs && value <= terminalAtMs ? value : null;
}

function dedupeToolRecords(records: readonly ToolCallObservation[]): ToolCallObservation[] {
  const byId = new Map<string, ToolCallObservation>();
  const withoutId: ToolCallObservation[] = [];
  for (const record of records) {
    if (!record.callId) {
      withoutId.push(record);
      continue;
    }
    const current = byId.get(record.callId);
    if (!current || record.status === "failed" || (record.status === "completed" && current.status === "unknown")) {
      byId.set(record.callId, { ...current, ...record });
    }
  }
  return [...byId.values(), ...withoutId];
}

function sumKnown(values: readonly (number | undefined | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null || value === undefined)) return null;
  return values.reduce<number>((sum, value) => sum + (value as number), 0);
}

function parseJsonValue(stdout: string): unknown {
  const candidates = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).reverse();
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as unknown; } catch { /* bounded informational line */ }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
