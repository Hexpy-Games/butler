import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { BenchmarkTarget } from "./contracts.ts";

export interface TurnEvent {
  atMs: number;
  kind: string;
  payload: Record<string, unknown>;
  toolCallId: string | null;
}

export interface UsageSummary {
  cachedPromptTokens: number | null;
  model: string | null;
  modelRequests: number | null;
  outputTokens: number | null;
  promptTokens: number | null;
  totalTokens: number | null;
}

export function readProductUsage(
  dataRoot: string,
  target: BenchmarkTarget,
): UsageSummary {
  const path = join(dataRoot, "metrics", "prompt-cache-usage.jsonl");
  if (!existsSync(path)) return emptyUsage();
  const entries = readJsonLines(path).filter((entry) =>
    !String(entry.scope ?? "").includes("title-provider"),
  );
  if (entries.length === 0) return emptyUsage();
  const promptTokens = sumNullable(entries, "promptTokens");
  const cachedPromptTokens = sumNullable(entries, "cachedTokens");
  const totalTokens = sumNullable(entries, "totalTokens");
  const bareModel = entries.map((entry) => stringValue(entry.model)).find(Boolean) ?? null;
  return {
    model: bareModel && target.model.endsWith(`/${bareModel}`) ? target.model : bareModel,
    modelRequests: entries.length,
    promptTokens,
    cachedPromptTokens,
    outputTokens: promptTokens === null || totalTokens === null
      ? null
      : Math.max(0, totalTokens - promptTokens),
    totalTokens,
  };
}

export function readTurnEvents(dataRoot: string, turnId: string): TurnEvent[] {
  const directory = join(dataRoot, "transcripts");
  if (!turnId || !existsSync(directory)) return [];
  const events: TurnEvent[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const entry of readJsonLines(join(directory, name))) {
      const payload = record(entry.payload);
      const metadata = record(payload.metadata);
      const event = record(metadata.event);
      if (stringValue(metadata.turnId) !== turnId) continue;
      const kind = stringValue(event.kind);
      const atMs = Date.parse(stringValue(event.createdAt) ?? stringValue(entry.timestamp) ?? "");
      if (!kind || !Number.isFinite(atMs)) continue;
      events.push({
        atMs,
        kind,
        payload: record(event.payload),
        toolCallId: stringValue(record(event.payload).toolCallId),
      });
    }
  }
  return events.sort((left, right) => left.atMs - right.atMs);
}

export function summarizeTools(
  events: TurnEvent[],
  delivered: boolean,
  terminalAtMs: number,
): {
  calls: number;
  failedCalls: number;
  recoveredErrors: number;
  recoveryTimeMs: number;
} {
  const started = new Set(
    events.filter((event) => event.kind === "tool.started")
      .map((event) => event.toolCallId)
      .filter((value): value is string => Boolean(value)),
  );
  const failed = events.filter((event) => event.kind === "tool.failed");
  const firstFailure = failed[0]?.atMs;
  return {
    calls: started.size,
    failedCalls: failed.length,
    recoveredErrors: delivered ? failed.length : 0,
    recoveryTimeMs: firstFailure === undefined || !delivered
      ? 0
      : Math.max(0, terminalAtMs - firstFailure),
  };
}

export function eventTime(events: TurnEvent[], kind: string): number | null {
  return events.find((event) => event.kind === kind)?.atMs ?? null;
}

export function firstMeaningfulEventTime(events: TurnEvent[]): number | null {
  const concrete = events.find((event) => {
    if (CONCRETE_PROGRESS_EVENT_KINDS.has(event.kind)) return true;
    if (event.kind !== "assistant.public_note") return false;
    return stringValue(event.payload.decisionSource) === "model-authored" ||
      stringValue(event.payload.decisionTitle) !== null ||
      stringValue(event.payload.decisionSummary) !== null;
  });
  return concrete?.atMs ?? eventTime(events, "message.final.started");
}

export function maxSilentGap(
  events: TurnEvent[],
  submittedAtMs: number | null,
  terminalAtMs: number,
): number | null {
  if (submittedAtMs === null) return null;
  const points = [
    submittedAtMs,
    ...events.map((event) => event.atMs)
      .filter((value) => value >= submittedAtMs && value <= terminalAtMs),
    terminalAtMs,
  ];
  return points.slice(1).reduce(
    (maximum, value, index) => Math.max(maximum, value - points[index]!),
    0,
  );
}

export function countProtocolJargon(messages: string[]): number {
  const pattern =
    /\b(?:BTCC|GoalContract|carrier|checkpoint hash|manifest revision|semantic state)\b|목표 계약 해시|체크포인트 해시/iu;
  return messages.filter((message) => pattern.test(message)).length;
}

const CONCRETE_PROGRESS_EVENT_KINDS = new Set([
  "assistant.decision",
  "assistant.decision.completed",
  "model.stream.text_delta",
  "work.block.started",
  "work.block.updated",
  "work.block.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "tool.failed",
  "message.final.delta",
  "message.final.completed",
]);

function emptyUsage(): UsageSummary {
  return {
    cachedPromptTokens: null,
    model: null,
    modelRequests: null,
    outputTokens: null,
    promptTokens: null,
    totalTokens: null,
  };
}

function readJsonLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [record(JSON.parse(line) as unknown)];
      } catch {
        return [];
      }
    });
}

function sumNullable(entries: Record<string, unknown>[], key: string): number | null {
  const values = entries.map((entry) =>
    typeof entry[key] === "number" && Number.isFinite(entry[key])
      ? entry[key] as number
      : null,
  );
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
