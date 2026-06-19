import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import type { PromptSection } from "../../agent/prompt/prompt-assembler.ts";
import {
  estimateContextTokens,
  evaluateContextBudget,
  type ContextThresholdState,
} from "../../agent/context/budget.ts";

export type ContextPressureLevel = "low" | "medium" | "high";

export interface PromptAssemblyContextMetric {
  kind: "prompt_assembly";
  ts: number;
  sessionId: string;
  role: string;
  totalChars: number;
  stablePrefixChars?: number;
  stablePrefixHash?: string;
  sections: Array<{
    id: string;
    title: string;
    chars: number;
  }>;
}

export interface RuntimeTurnContextMetric {
  kind: "runtime_turn";
  ts: number;
  sessionId: string;
  model: string | null;
  totalPromptChars: number;
  promptContextChars: number;
  compactionContextChars?: number;
  feedbackBufferContextChars?: number;
  workingMemoryContextChars?: number;
  recentConversationChars: number;
  recallContextChars: number;
  inboundMessageChars: number;
}

export interface RuntimeTurnPreparationStageMetric {
  kind: "runtime_preparation_stage";
  ts: number;
  sessionId: string;
  turnId: string | null;
  model: string | null;
  stage: string;
  elapsedMs: number;
  durationMs: number | null;
  counters: Record<string, number | boolean>;
}

export type ContextMetricEvent =
  | PromptAssemblyContextMetric
  | RuntimeTurnContextMetric
  | RuntimeTurnPreparationStageMetric;

export interface ContextMonitorSummary {
  sessionId: string;
  telemetry: {
    events: number;
    parseErrors: number;
  };
  latestPromptAssembly: (PromptAssemblyContextMetric & { estimatedTokens: number }) | null;
  latestTurn: (RuntimeTurnContextMetric & { estimatedTokens: number }) | null;
  transcript: {
    exists: boolean;
    path: string;
    bytes: number;
    events: number;
    conversationEvents: number;
    latestTimestamp: string | null;
  };
  pressure: {
    level: ContextPressureLevel;
    thresholdState: ContextThresholdState;
    totalChars: number;
    estimatedTokens: number;
    contextWindowTokens: number;
    reservedOutputTokens: number;
    reservedToolTokens: number;
    freeTokens: number;
    freeTokensAfterReserve: number;
    usedRatio: number;
    contributors: {
      systemPromptChars: number;
      turnPromptChars: number;
      transcriptBytes: number;
    };
  };
  privacy: {
    rawTextStored: false;
  };
}

export function contextMetricsPath(butlerData: string): string {
  return join(butlerData, "metrics", "context-monitor.jsonl");
}

function transcriptPathForData(butlerData: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(butlerData, "transcripts", `${safeSessionId}.jsonl`);
}

function appendContextMetric(butlerData: string, event: ContextMetricEvent): void {
  const path = contextMetricsPath(butlerData);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function appendPromptAssemblyContextMetric(input: {
  butlerData: string;
  sessionId: string;
  role: string;
  sections: PromptSection[];
  systemPrompt: string;
  stablePrefixChars?: number;
  stablePrefixHash?: string;
  now?: number;
}): void {
  appendContextMetric(input.butlerData, {
    kind: "prompt_assembly",
    ts: input.now ?? Date.now(),
    sessionId: input.sessionId,
    role: input.role,
    totalChars: input.systemPrompt.length,
    stablePrefixChars: input.stablePrefixChars,
    stablePrefixHash: input.stablePrefixHash,
    sections: input.sections.map((section) => ({
      id: section.id,
      title: section.title,
      chars: section.content.length,
    })),
  });
}

export function appendRuntimeTurnContextMetric(input: {
  butlerData: string;
  sessionId: string;
  model?: string;
  totalPromptChars: number;
  promptContextChars: number;
  compactionContextChars?: number;
  feedbackBufferContextChars?: number;
  workingMemoryContextChars?: number;
  recentConversationChars: number;
  recallContextChars: number;
  inboundMessageChars: number;
  now?: number;
}): void {
  appendContextMetric(input.butlerData, {
    kind: "runtime_turn",
    ts: input.now ?? Date.now(),
    sessionId: input.sessionId,
    model: input.model ?? null,
    totalPromptChars: input.totalPromptChars,
    promptContextChars: input.promptContextChars,
    compactionContextChars: input.compactionContextChars,
    feedbackBufferContextChars: input.feedbackBufferContextChars,
    workingMemoryContextChars: input.workingMemoryContextChars,
    recentConversationChars: input.recentConversationChars,
    recallContextChars: input.recallContextChars,
    inboundMessageChars: input.inboundMessageChars,
  });
}

export function appendRuntimeTurnPreparationStageMetric(input: {
  butlerData: string;
  sessionId: string;
  turnId?: string | null;
  model?: string | null;
  stage: string;
  elapsedMs: number;
  durationMs?: number | null;
  counters?: Record<string, unknown>;
  now?: number;
}): void {
  appendContextMetric(input.butlerData, {
    kind: "runtime_preparation_stage",
    ts: input.now ?? Date.now(),
    sessionId: input.sessionId,
    turnId: input.turnId ?? null,
    model: input.model ?? null,
    stage: safeMetricLabel(input.stage, "unknown"),
    elapsedMs: safeNonNegativeNumber(input.elapsedMs),
    durationMs: input.durationMs == null ? null : safeNonNegativeNumber(input.durationMs),
    counters: safeMetricCounters(input.counters ?? {}),
  });
}

export function readContextMetrics(input: {
  butlerData: string;
  sessionId?: string;
}): ContextMetricEvent[] {
  return readContextMetricsWithDiagnostics(input).events;
}

function readContextMetricsWithDiagnostics(input: {
  butlerData: string;
  sessionId?: string;
}): { events: ContextMetricEvent[]; parseErrors: number } {
  const path = contextMetricsPath(input.butlerData);
  if (!existsSync(path)) return { events: [], parseErrors: 0 };
  const events: ContextMetricEvent[] = [];
  let parseErrors = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ContextMetricEvent;
      if (
        typeof parsed?.kind === "string" &&
        typeof parsed?.ts === "number" &&
        typeof parsed?.sessionId === "string" &&
        (!input.sessionId || parsed.sessionId === input.sessionId)
      ) {
        events.push(parsed);
      }
    } catch {
      parseErrors += 1;
    }
  }
  return {
    events: events.sort((a, b) => a.ts - b.ts),
    parseErrors,
  };
}

function safeMetricLabel(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return text.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 80) || fallback;
}

function safeNonNegativeNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

function safeMetricCounters(input: Record<string, unknown>): Record<string, number | boolean> {
  const counters: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    const safeKey = safeMetricLabel(key, "");
    if (!safeKey) continue;
    if (typeof value === "boolean") {
      counters[safeKey] = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    counters[safeKey] = Math.round(value);
  }
  return counters;
}

function readTranscriptStats(butlerData: string, sessionId: string): ContextMonitorSummary["transcript"] {
  const path = transcriptPathForData(butlerData, sessionId);
  if (!existsSync(path)) {
    return {
      exists: false,
      path,
      bytes: 0,
      events: 0,
      conversationEvents: 0,
      latestTimestamp: null,
    };
  }
  let events = 0;
  let conversationEvents = 0;
  let latestTimestamp: string | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        kind?: unknown;
        timestamp?: unknown;
      };
      events += 1;
      if (parsed.kind === "inbound" || parsed.kind === "outbound") {
        conversationEvents += 1;
      }
      if (typeof parsed.timestamp === "string") latestTimestamp = parsed.timestamp;
    } catch {
      continue;
    }
  }
  return {
    exists: true,
    path,
    bytes: statSync(path).size,
    events,
    conversationEvents,
    latestTimestamp,
  };
}

export function readContextMonitor(input: {
  butlerData: string;
  sessionId?: string;
}): ContextMonitorSummary {
  const sessionId = input.sessionId?.trim() || "butler/main";
  const telemetry = readContextMetricsWithDiagnostics({
    butlerData: input.butlerData,
    sessionId,
  });
  const events = telemetry.events;
  const latestPrompt = [...events].reverse()
    .find((event): event is PromptAssemblyContextMetric => event.kind === "prompt_assembly") ?? null;
  const latestTurn = [...events].reverse()
    .find((event): event is RuntimeTurnContextMetric => event.kind === "runtime_turn") ?? null;
  const transcript = readTranscriptStats(input.butlerData, sessionId);
  const systemPromptChars = latestPrompt?.totalChars ?? 0;
  const turnPromptChars = latestTurn?.totalPromptChars ?? 0;
  const totalChars = systemPromptChars + turnPromptChars;
  const estimatedTokens = estimateContextTokens(totalChars);
  const budget = evaluateContextBudget({
    modelRef: latestTurn?.model ?? undefined,
    inputTokens: estimatedTokens,
  });

  return {
    sessionId,
    telemetry: {
      events: events.length,
      parseErrors: telemetry.parseErrors,
    },
    latestPromptAssembly: latestPrompt
      ? {
          ...latestPrompt,
          estimatedTokens: estimateContextTokens(latestPrompt.totalChars),
        }
      : null,
    latestTurn: latestTurn
      ? {
          ...latestTurn,
          estimatedTokens: estimateContextTokens(latestTurn.totalPromptChars),
        }
      : null,
    transcript,
    pressure: {
      level: budget.pressureLevel,
      thresholdState: budget.thresholdState,
      totalChars,
      estimatedTokens,
      contextWindowTokens: budget.contextWindowTokens,
      reservedOutputTokens: budget.reservedOutputTokens,
      reservedToolTokens: budget.reservedToolTokens,
      freeTokens: budget.freeTokens,
      freeTokensAfterReserve: budget.freeTokensAfterReserve,
      usedRatio: budget.usedRatio,
      contributors: {
        systemPromptChars,
        turnPromptChars,
        transcriptBytes: transcript.bytes,
      },
    },
    privacy: {
      rawTextStored: false,
    },
  };
}
