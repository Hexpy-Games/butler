import { appendFileSync, mkdirSync, statSync } from "fs";
import { dirname, join } from "path";
import type { PromptSection } from "../../agent/prompt/prompt-assembler.ts";
import { readIncrementalJsonlSnapshot } from "./incremental-jsonl-snapshot.ts";

export interface PromptAssemblyContextMetric {
  kind: "prompt_assembly";
  ts: number;
  sessionId: string;
  role: string;
  totalChars: number;
  stablePrefixChars?: number;
  stablePrefixHash?: string;
  sections: Array<{ id: string; title: string; chars: number }>;
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
  focusedResumeEnvelopeChars?: number;
  resumeDecisionEnvelopeChars?: number;
}

export type ContextMetricEvent = PromptAssemblyContextMetric | RuntimeTurnContextMetric;

export function contextMetricsPath(butlerData: string): string {
  return join(butlerData, "metrics", "context-monitor.jsonl");
}

export function contextMetricsRevision(butlerData: string): string {
  const path = contextMetricsPath(butlerData);
  try {
    const stat = statSync(path);
    return `${path}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${path}:missing`;
  }
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
  focusedResumeEnvelopeChars?: number;
  resumeDecisionEnvelopeChars?: number;
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
    focusedResumeEnvelopeChars: input.focusedResumeEnvelopeChars,
    resumeDecisionEnvelopeChars: input.resumeDecisionEnvelopeChars,
  });
}

export function readContextMetrics(input: {
  butlerData: string;
  sessionId?: string;
}): ContextMetricEvent[] {
  const path = contextMetricsPath(input.butlerData);
  const cached = readIncrementalJsonlSnapshot(path, parseContextMetricLine);
  return cached.values
    .filter((event) => !input.sessionId || event.sessionId === input.sessionId)
    .sort((a, b) => a.ts - b.ts);
}

function parseContextMetricLine(line: string): ContextMetricEvent | null {
  try {
    const parsed = JSON.parse(line) as ContextMetricEvent;
    return (parsed?.kind === "prompt_assembly" || parsed?.kind === "runtime_turn") &&
      typeof parsed?.ts === "number" &&
      typeof parsed?.sessionId === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}
