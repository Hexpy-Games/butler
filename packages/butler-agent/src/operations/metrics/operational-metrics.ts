import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { appendFileSync } from "fs";
import { join } from "path";
import {
  addOperationalMetricSummaryEvent,
  createOperationalMetricSummaryAccumulator,
  finalizeOperationalMetricSummary,
} from "./operational-metric-summary.ts";
import {
  getButlerData,
  normalizeOperationalMetric,
  operationalMetricsDir,
  operationalMetricsPath,
  visitOperationalMetricEvents,
} from "./operational-metric-log.ts";

export {
  operationalMetricsDir,
  operationalMetricsPath,
  readOperationalMetricEvents,
  visitOperationalMetricEvents,
} from "./operational-metric-log.ts";

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
    appendFileSync(operationalMetricsPath(butlerData), `${JSON.stringify(normalizeOperationalMetric(input))}\n`, "utf8");
  } catch {
    // Metrics are diagnostic only and must never block live work.
  }
}

export function readOperationalMetricSummary(input: OperationalMetricReadOptions = {}): OperationalMetricSummary {
  const butlerData = getButlerData(input.butlerData);
  const accumulator = createOperationalMetricSummaryAccumulator();
  const { parseErrors } = visitOperationalMetricEvents({
    ...input,
    onEvent: (event) => addOperationalMetricSummaryEvent(accumulator, event),
  });
  return finalizeOperationalMetricSummary(accumulator, {
    enabled: isOperationalMetricsEnabled({ butlerData }),
    parseErrors,
    sinceTs: typeof input.sinceTs === "number" ? input.sinceTs : null,
  });
}

export function tailOperationalMetricEvents(input: OperationalMetricReadOptions & {
  lines?: number;
} = {}): OperationalMetricEvent[] {
  const count = Math.max(0, Math.min(500, input.lines ?? 20));
  if (count === 0) return [];
  const events: OperationalMetricEvent[] = [];
  visitOperationalMetricEvents({
    ...input,
    onEvent: (event) => {
      events.push(event);
      if (events.length > count) events.shift();
    },
  });
  return events;
}
