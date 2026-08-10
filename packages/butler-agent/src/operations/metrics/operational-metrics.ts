import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type OperationalMetricCategory =
  | "ingress"
  | "session"
  | "runtime"
  | "tool"
  | "worker"
  | "delivery"
  | "context"
  | "memory"
  | "search"
  | "maintenance"
  | "process"
  | "cli";

export type OperationalMetricStatus = "ok" | "error" | "skipped";

export interface OperationalMetricInput {
  ts?: number;
  category: OperationalMetricCategory;
  name: string;
  status: OperationalMetricStatus;
  durationMs?: number;
  value?: number;
  unit?: string;
  dimensions?: Record<string, unknown>;
}

export interface OperationalMetricEvent {
  schema: "butler.operational-metric.v1";
  ts: number;
  category: OperationalMetricCategory;
  name: string;
  status: OperationalMetricStatus;
  durationMs?: number;
  value?: number;
  unit?: string;
  dimensions?: Record<string, string | number | boolean | null>;
  rawTextStored: false;
}

export interface OperationalMetricReadOptions {
  butlerData?: string;
  sinceTs?: number;
}

export interface OperationalMetricSummaryBucket {
  events: number;
  errors: number;
  skipped: number;
  durationMs: {
    count: number;
    min: number | null;
    max: number | null;
    average: number | null;
    p50: number | null;
    p95: number | null;
  };
}

export interface OperationalMetricSummary {
  enabled: boolean;
  totalEvents: number;
  parseErrors: number;
  sinceTs: number | null;
  byCategory: Partial<Record<OperationalMetricCategory, OperationalMetricSummaryBucket>>;
  byName: Record<string, OperationalMetricSummaryBucket>;
  latestEventTs: number | null;
  privacy: {
    rawTextStored: false;
    rawPromptsIncluded: false;
    rawMessagesIncluded: false;
    rawToolPayloadsIncluded: false;
    rawCredentialsIncluded: false;
  };
}

interface ConfigFile {
  metrics?: {
    enabled?: unknown;
    retentionDays?: unknown;
  };
  [key: string]: unknown;
}

const FALSE_VALUES = new Set(["0", "false", "off", "no"]);
const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const MAX_DIMENSION_STRING = 160;

function getButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

export function operationalMetricsDir(butlerData = getButlerData()): string {
  return join(butlerData, "metrics");
}

export function operationalMetricsPath(butlerData = getButlerData()): string {
  return join(operationalMetricsDir(butlerData), "operational-events.jsonl");
}

function configPath(butlerData: string): string {
  return join(butlerData, "butler.config.json");
}

function readConfig(butlerData: string): ConfigFile {
  const path = configPath(butlerData);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as ConfigFile : {};
  } catch {
    return {};
  }
}

export function isOperationalMetricsEnabled(input: {
  butlerData?: string;
  env?: Record<string, string | undefined>;
} = {}): boolean {
  const env = input.env ?? process.env;
  const envValue = env.BUTLER_METRICS_ENABLED?.trim().toLowerCase();
  if (envValue && FALSE_VALUES.has(envValue)) return false;
  if (envValue && TRUE_VALUES.has(envValue)) return true;

  const cfg = readConfig(getButlerData(input.butlerData));
  if (cfg.metrics?.enabled === false) return false;
  return true;
}

export function setOperationalMetricsEnabled(input: {
  butlerData?: string;
  enabled: boolean;
}): void {
  const butlerData = getButlerData(input.butlerData);
  mkdirSync(butlerData, { recursive: true });
  const cfg = readConfig(butlerData);
  cfg.metrics = {
    ...(cfg.metrics && typeof cfg.metrics === "object" ? cfg.metrics : {}),
    enabled: input.enabled,
  };
  writeFileSync(configPath(butlerData), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
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
  if (key === "resultRef") {
    if (value === null) return null;
    if (typeof value !== "string" || !/^guided-result-[a-f0-9]{64}$/u.test(value.trim())) {
      return undefined;
    }
    return value.trim();
  }
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

function sanitizeMetricIdentifier(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(trimmed) ? trimmed : fallback;
}

function sanitizeDimensions(dimensions: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> | undefined {
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

function normalizeEvent(input: OperationalMetricInput): OperationalMetricEvent {
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

export function recordOperationalMetric(
  input: OperationalMetricInput,
  options: {
    butlerData?: string;
    env?: Record<string, string | undefined>;
  } = {},
): void {
  if (!isOperationalMetricsEnabled({
    butlerData: options.butlerData,
    env: options.env,
  })) {
    return;
  }
  const butlerData = getButlerData(options.butlerData);
  try {
    mkdirSync(operationalMetricsDir(butlerData), { recursive: true });
    appendFileSync(operationalMetricsPath(butlerData), `${JSON.stringify(normalizeEvent(input))}\n`, "utf8");
  } catch {
    // Metrics are diagnostic only and must never block live work.
  }
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
      events.push({
        ...parsed,
        rawTextStored: false,
        dimensions: sanitizeDimensions(parsed.dimensions),
      });
    } catch {
      continue;
    }
  }
  return events;
}

function readEventsWithParseErrors(input: OperationalMetricReadOptions = {}): {
  events: OperationalMetricEvent[];
  parseErrors: number;
} {
  const path = operationalMetricsPath(getButlerData(input.butlerData));
  if (!existsSync(path)) return { events: [], parseErrors: 0 };
  const events: OperationalMetricEvent[] = [];
  let parseErrors = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isOperationalMetricEvent(parsed)) continue;
      if (typeof input.sinceTs === "number" && parsed.ts < input.sinceTs) continue;
      events.push({
        ...parsed,
        rawTextStored: false,
        dimensions: sanitizeDimensions(parsed.dimensions),
      });
    } catch {
      parseErrors += 1;
    }
  }
  return { events, parseErrors };
}

function emptyBucket(): OperationalMetricSummaryBucket {
  return {
    events: 0,
    errors: 0,
    skipped: 0,
    durationMs: {
      count: 0,
      min: null,
      max: null,
      average: null,
      p50: null,
      p95: null,
    },
  };
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function finalizeBucket(bucket: OperationalMetricSummaryBucket, durations: number[]): void {
  if (!durations.length) return;
  const sum = durations.reduce((total, value) => total + value, 0);
  bucket.durationMs = {
    count: durations.length,
    min: Math.min(...durations),
    max: Math.max(...durations),
    average: Number((sum / durations.length).toFixed(2)),
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
  };
}

export function readOperationalMetricSummary(input: OperationalMetricReadOptions = {}): OperationalMetricSummary {
  const butlerData = getButlerData(input.butlerData);
  const { events, parseErrors } = readEventsWithParseErrors(input);
  const byCategory: Partial<Record<OperationalMetricCategory, OperationalMetricSummaryBucket>> = {};
  const byName: Record<string, OperationalMetricSummaryBucket> = {};
  const durationsByCategory: Partial<Record<OperationalMetricCategory, number[]>> = {};
  const durationsByName: Record<string, number[]> = {};
  let latestEventTs: number | null = null;

  for (const event of events) {
    const categoryBucket = byCategory[event.category] ??= emptyBucket();
    const nameKey = `${event.category}:${event.name}`;
    const nameBucket = byName[nameKey] ??= emptyBucket();
    categoryBucket.events += 1;
    nameBucket.events += 1;
    if (event.status === "error") {
      categoryBucket.errors += 1;
      nameBucket.errors += 1;
    }
    if (event.status === "skipped") {
      categoryBucket.skipped += 1;
      nameBucket.skipped += 1;
    }
    if (typeof event.durationMs === "number") {
      (durationsByCategory[event.category] ??= []).push(event.durationMs);
      (durationsByName[nameKey] ??= []).push(event.durationMs);
    }
    latestEventTs = latestEventTs === null ? event.ts : Math.max(latestEventTs, event.ts);
  }
  for (const [category, bucket] of Object.entries(byCategory)) {
    finalizeBucket(bucket, durationsByCategory[category as OperationalMetricCategory] ?? []);
  }
  for (const [name, bucket] of Object.entries(byName)) {
    finalizeBucket(bucket, durationsByName[name] ?? []);
  }

  return {
    enabled: isOperationalMetricsEnabled({ butlerData }),
    totalEvents: events.length,
    parseErrors,
    sinceTs: typeof input.sinceTs === "number" ? input.sinceTs : null,
    byCategory,
    byName,
    latestEventTs,
    privacy: {
      rawTextStored: false,
      rawPromptsIncluded: false,
      rawMessagesIncluded: false,
      rawToolPayloadsIncluded: false,
      rawCredentialsIncluded: false,
    },
  };
}

export function tailOperationalMetricEvents(input: OperationalMetricReadOptions & {
  lines?: number;
} = {}): OperationalMetricEvent[] {
  const count = Math.max(0, Math.min(500, input.lines ?? 20));
  if (count === 0) return [];
  return readOperationalMetricEvents(input).slice(-count);
}
