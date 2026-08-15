import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { scanJsonlFile } from "./jsonl-file-scanner.ts";
import type {
  OperationalMetricEvent,
  OperationalMetricInput,
  OperationalMetricReadOptions,
} from "./operational-metrics.ts";

const MAX_DIMENSION_STRING = 160;

export function getButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

export function operationalMetricsDir(butlerData = getButlerData()): string {
  return join(butlerData, "metrics");
}

export function operationalMetricsPath(butlerData = getButlerData()): string {
  return join(operationalMetricsDir(butlerData), "operational-events.jsonl");
}

function isMetricCountKey(key: string, value: unknown): boolean {
  if (typeof value !== "number") return false;
  const lower = key.toLowerCase();
  return /(tokens|chars|bytes|count|ratio|ms|duration|latency|attempts|retries|failures|successes)$/.test(lower);
}

function isUnsafeDimensionKey(key: string, value: unknown): boolean {
  const lower = key.toLowerCase();
  if (isMetricCountKey(lower, value)) return false;
  return /(^|[_-])(prompt|message|transcript|query|url|uri|args?|arguments?|result|content|raw|secret|password|credential|apikey|api_key|key|token)([_-]|$)/.test(lower) ||
    /^(prompt|message|transcript|query|url|uri|args?|arguments?|result|content|raw|secret|password|credential|apikey|api_key|key|token)$/i.test(key);
}

function sanitizeDimensionValue(key: string, value: unknown): string | number | boolean | null | undefined {
  if (isUnsafeDimensionKey(key, value)) return undefined;
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return undefined;
  if (trimmed.length > MAX_DIMENSION_STRING) return `${trimmed.slice(0, MAX_DIMENSION_STRING)}…`;
  return trimmed;
}

function sanitizeDimensionKey(key: string): string | undefined {
  const trimmed = key.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(trimmed)) return undefined;
  return trimmed;
}

export function sanitizeMetricIdentifier(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(trimmed) ? trimmed : fallback;
}

export function sanitizeDimensions(
  dimensions: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!dimensions) return undefined;
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(dimensions)) {
    const safeKey = sanitizeDimensionKey(key);
    if (!safeKey) continue;
    const safeValue = sanitizeDimensionValue(safeKey, value);
    if (safeValue !== undefined) safe[safeKey] = safeValue;
  }
  return Object.keys(safe).length ? safe : undefined;
}

export function normalizeOperationalMetric(input: OperationalMetricInput): OperationalMetricEvent {
  const event: OperationalMetricEvent = {
    schema: "butler.operational-metric.v1",
    ts: typeof input.ts === "number" && Number.isFinite(input.ts) ? input.ts : Date.now(),
    category: input.category,
    name: sanitizeMetricIdentifier(input.name, "unknown"),
    status: input.status,
    rawTextStored: false,
  };
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
    event.durationMs = Math.max(0, input.durationMs);
  }
  if (typeof input.value === "number" && Number.isFinite(input.value)) event.value = input.value;
  if (typeof input.unit === "string" && input.unit.trim()) {
    event.unit = sanitizeMetricIdentifier(input.unit, "unit");
  }
  const dimensions = sanitizeDimensions(input.dimensions);
  if (dimensions) event.dimensions = dimensions;
  return event;
}

function isOperationalMetricEvent(value: unknown): value is OperationalMetricEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OperationalMetricEvent>;
  return record.schema === "butler.operational-metric.v1" &&
    typeof record.ts === "number" &&
    typeof record.category === "string" &&
    typeof record.name === "string" &&
    (record.status === "ok" || record.status === "error" || record.status === "skipped");
}

function sanitizedEvent(value: OperationalMetricEvent): OperationalMetricEvent {
  return {
    ...value,
    rawTextStored: false,
    dimensions: sanitizeDimensions(value.dimensions),
  };
}

export function readOperationalMetricEvents(input: OperationalMetricReadOptions = {}): OperationalMetricEvent[] {
  const path = operationalMetricsPath(getButlerData(input.butlerData));
  if (!existsSync(path)) return [];
  const events: OperationalMetricEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isOperationalMetricEvent(parsed)) continue;
      if (typeof input.sinceTs === "number" && parsed.ts < input.sinceTs) continue;
      events.push(sanitizedEvent(parsed));
    } catch {
      continue;
    }
  }
  return events;
}

export function visitOperationalMetricEvents(input: OperationalMetricReadOptions & {
  onEvent: (event: OperationalMetricEvent) => void;
}): { parseErrors: number } {
  const path = operationalMetricsPath(getButlerData(input.butlerData));
  if (!existsSync(path)) return { parseErrors: 0 };
  let parseErrors = 0;
  const visit = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isOperationalMetricEvent(parsed)) return;
      if (typeof input.sinceTs === "number" && parsed.ts < input.sinceTs) return;
      input.onEvent(sanitizedEvent(parsed));
    } catch {
      parseErrors += 1;
    }
  };
  try {
    scanJsonlFile(path, { onLine: visit, onTrailing: visit });
  } catch {
    // A rotating metrics file must not make a status request fail.
  }
  return { parseErrors };
}
