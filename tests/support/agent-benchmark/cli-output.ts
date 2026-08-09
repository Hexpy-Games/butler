import type {
  AdapterRunInput,
  BenchmarkGateCode,
  TokenUsage,
  ToolCallObservation,
  ToolMetrics,
} from "./contracts.ts";

export interface ParsedCliOutput {
  finalText: string | null;
  firstUsefulOutputAtMs: number | null;
  usage: Partial<TokenUsage>;
  tools: Partial<ToolMetrics>;
  changedPaths: string[];
  sessionId: string | null;
  gateCode: BenchmarkGateCode;
  effectiveModel: string | null;
}

export function parseCliOutput(
  agent: "hermes" | "opencode",
  stdout: string,
  firstUsefulOutputAtMs: number | null = null,
): ParsedCliOutput {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const events = lines.flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return asRecord(value) ? [asRecord(value)!] : [];
    } catch {
      return [];
    }
  });
  const textEvents = events.flatMap((event) => {
    const nested = asRecord(event.part) ?? asRecord(asRecord(event.properties)?.part);
    const text = event.text ?? event.content ?? event.message ?? nested?.text ?? nested?.content;
    return typeof text === "string" ? [text] : [];
  });
  const plainTextLines = lines.filter((line) => {
    if (isHermesSessionMetadata(line)) return false;
    try {
      return !asRecord(JSON.parse(line));
    } catch {
      return true;
    }
  });
  const fallbackText = agent === "hermes"
    ? plainTextLines.at(-1) ?? null
    : plainTextLines.at(-1) ?? lines.at(-1);
  const finalText = textEvents.at(-1) ?? fallbackText ?? null;
  const usage = aggregateUsage(events);
  const toolMetrics = aggregateToolRecords(events, agent);
  const structuredUsefulTime = agent === "opencode" ? firstTextEventTime(events) : null;
  const changedPaths = events.flatMap((event) => {
    const path = event.path ?? asRecord(event.part)?.path ?? asRecord(asRecord(event.properties)?.part)?.path;
    return typeof path === "string" && !path.startsWith("/") && !path.includes("..") ? [path] : [];
  });
  const sessionId = events.map((event) => normalizeSessionId(event.sessionID ?? event.sessionId ?? event.session_id ?? asRecord(event.properties)?.sessionID ?? asRecord(event.properties)?.sessionId))
    .find((value): value is string => value !== null) ??
    normalizeSessionId(stdout.match(/(?:^|\n)\s*(?:session|session[_ -]*id)\s*:\s*([A-Za-z0-9_-]{1,160})\s*$/imu)?.[1]) ?? null;
  const effectiveModel = events.map((event) => event.model ?? event.modelID ?? event.model_id)
    .find((value): value is string => typeof value === "string") ?? null;
  return {
    finalText,
    firstUsefulOutputAtMs: finalText ? (agent === "opencode" ? structuredUsefulTime : firstUsefulOutputAtMs) : null,
    usage,
    tools: toolMetrics,
    changedPaths,
    sessionId,
    gateCode: "none",
    effectiveModel,
  };
}

function isHermesSessionMetadata(line: string): boolean {
  return /^\s*(?:session|session[_ -]*id)\s*:\s*[A-Za-z0-9_-]{1,160}\s*$/iu.test(line);
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{1,160}$/u.test(normalized) ? normalized : null;
}

function aggregateUsage(events: readonly Record<string, unknown>[]): Partial<TokenUsage> {
  const usageRecords = events.flatMap((event) => {
    const properties = asRecord(event.properties);
    return [
      [asRecord(event.usage), usageRecordId(event, asRecord(event.usage))],
      [asRecord(properties?.usage), usageRecordId(properties ?? event, asRecord(properties?.usage))],
    ] as Array<[Record<string, unknown> | null, string | null]>;
  }).filter((entry): entry is [Record<string, unknown>, string | null] => entry[0] !== null);
  const stepFinishRecords = events.flatMap((event) => stepFinishUsage(event));
  if (usageRecords.length === 0 && stepFinishRecords.length === 0) return {};
  const selected = selectUsageRecords(stepFinishRecords.length > 0 ? stepFinishRecords : usageRecords);
  if (!selected) return unknownUsage();
  const fields = {
    inputTokens: ["input_tokens", "inputTokens"],
    cacheReadTokens: ["cache_read", "cacheReadTokens"],
    cacheWriteTokens: ["cache_write", "cacheWriteTokens"],
    outputTokens: ["output_tokens", "outputTokens"],
    totalTokens: ["total_tokens", "totalTokens"],
    modelRequests: ["model_requests", "modelRequests"],
  } as const;
  const usage: Partial<TokenUsage> = {};
  for (const [name, aliases] of Object.entries(fields) as Array<[keyof typeof fields, readonly string[]]>) {
    const values = selected.map((record) => numberOrNull(aliases.map((alias) => record[alias]).find((value) => value !== undefined)));
    (usage as Record<string, number | null>)[name] = values.every((value) => value !== null)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;
  }
  if (stepFinishRecords.length > 0) usage.modelRequests = selected.length;
  return usage;
}

function stepFinishUsage(event: Record<string, unknown>): [Record<string, unknown>, string | null][] {
  const part = asRecord(event.part) ?? asRecord(asRecord(event.properties)?.part);
  const type = String(part?.type ?? "").toLowerCase().replaceAll("_", "-");
  if (!part || type !== "step-finish") return [];
  const tokens = asRecord(part.tokens);
  if (!tokens) return [];
  const cache = asRecord(tokens.cache);
  const record: Record<string, unknown> = {
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    total_tokens: tokens.total,
    cache_read: cache?.read,
    cache_write: cache?.write,
  };
  const id = [part.id, part.partId, event.partId, event.id]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;
  return [[record, id]];
}

function selectUsageRecords(
  usageRecords: readonly [Record<string, unknown>, string | null][],
): Record<string, unknown>[] | null {
  if (usageRecords.length === 1) return [usageRecords[0]![0]];
  if (usageRecords.some(([, id]) => id === null)) return null;
  const grouped = new Map<string, Record<string, unknown>>();
  for (const [record, id] of usageRecords) {
    const key = id!;
    const current = grouped.get(key);
    if (!current || usageTotal(record) >= usageTotal(current)) grouped.set(key, record);
  }
  return [...grouped.values()];
}

function usageRecordId(event: Record<string, unknown>, usage: Record<string, unknown> | null): string | null {
  const values = [
    event.requestId, event.requestID, event.request_id,
    event.stepId, event.stepID, event.step_id,
    usage?.requestId, usage?.requestID, usage?.request_id,
    usage?.stepId, usage?.stepID, usage?.step_id,
  ];
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;
}

function usageTotal(record: Record<string, unknown>): number {
  const value = record.total_tokens ?? record.totalTokens;
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

function unknownUsage(): Partial<TokenUsage> {
  return {
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    totalTokens: null,
    modelRequests: null,
  };
}

function aggregateToolRecords(events: readonly Record<string, unknown>[], agent: "hermes" | "opencode"): ToolMetrics {
  const rawRecords = events.flatMap((event) => toolRecordForEvent(event));
  const keyed = new Map<string, ToolCallObservation>();
  const unkeyed: ToolCallObservation[] = [];
  for (const record of rawRecords) {
    if (!record.callId) {
      unkeyed.push(record);
      continue;
    }
    const current = keyed.get(record.callId);
    keyed.set(record.callId, current ? mergeToolRecord(current, record) : record);
  }
  const records = [...keyed.values(), ...unkeyed];
  if (agent === "hermes" && records.length === 0) return { calls: null, failedCalls: null, records: [] };
  const ambiguous = unkeyed.length > 1;
  return {
    calls: ambiguous ? null : records.length,
    failedCalls: ambiguous ? null : records.filter((record) => record.status === "failed").length,
    records,
  };
}

function mergeToolRecord(left: ToolCallObservation, right: ToolCallObservation): ToolCallObservation {
  const status = left.status === "failed" || right.status === "failed"
    ? "failed"
    : left.status === "completed" || right.status === "completed"
      ? "completed"
      : "unknown";
  return {
    callId: left.callId ?? right.callId ?? null,
    name: left.name ?? right.name,
    status,
    startedAtMs: minTime(left.startedAtMs, right.startedAtMs),
    endedAtMs: maxTime(left.endedAtMs, right.endedAtMs),
  };
}

function toolRecordForEvent(event: Record<string, unknown>): ToolCallObservation[] {
  const part = asRecord(event.part) ?? asRecord(asRecord(event.properties)?.part);
  const source = part ?? event;
  const type = String(source.type ?? event.type ?? "").toLowerCase();
  if (!type.includes("tool")) return [];
  const state = asRecord(source.state);
  const stateStatus = typeof state?.status === "string" ? state.status.toLowerCase() : "";
  const status = source.error || type.includes("fail") || type.includes("error") || stateStatus === "error" || stateStatus === "failed"
    ? "failed"
    : type.includes("complete") || type.includes("finish") || type.includes("success") || stateStatus === "completed" || stateStatus === "success"
      ? "completed"
      : "unknown";
  const callId = [source.callID, source.callId, source.toolCallId, source.tool_call_id, event.callID, event.callId, event.toolCallId, event.tool_call_id]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;
  const toolName = typeof source.name === "string" ? source.name : typeof source.tool === "string" ? source.tool : null;
  const time = asRecord(state?.time);
  return [{
    callId,
    name: toolName,
    status,
    startedAtMs: numberOrNull(time?.start),
    endedAtMs: numberOrNull(time?.end),
  } satisfies ToolCallObservation];
}

function firstTextEventTime(events: readonly Record<string, unknown>[]): number | null {
  for (const event of events) {
    const nested = asRecord(event.part) ?? asRecord(asRecord(event.properties)?.part);
    const text = event.text ?? event.content ?? event.message ?? nested?.text ?? nested?.content;
    const type = String(event.type ?? nested?.type ?? "").toLowerCase();
    if (typeof text === "string" && text.length > 0 && !type.includes("tool")) {
      const timestamp = event.timestamp ?? event.time ?? nested?.timestamp ?? nested?.time;
      const numeric = numberOrNull(timestamp);
      if (numeric !== null) return numeric;
    }
  }
  return null;
}

function minTime(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function maxTime(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

export function commandFor(
  agent: "hermes" | "opencode",
  input: AdapterRunInput,
): { args: string[] } {
  const config = input.arm.effectiveConfig;
  if (agent === "hermes") {
    const controlledFlags = input.arm.track === "controlled"
      ? ["--safe-mode", "--toolsets", "web,file", "--yolo"]
      : [];
    const args = ["chat", ...controlledFlags, "--quiet", "-q", input.prompt];
    if (config.model) args.splice(controlledFlags.length + 1, 0, "--model", config.model);
    if (input.sessionId) args.unshift("--resume", input.sessionId);
    return { args };
  }
  const args = ["run", "--format", "json", "--dir", input.arm.outputRoot, ...(input.arm.track === "controlled" ? ["--auto"] : [])];
  if (config.model) args.push("--model", config.model);
  if (config.variant) args.push("--variant", config.variant);
  if (input.sessionId) args.push("--session", input.sessionId);
  args.push(input.prompt);
  return { args };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
