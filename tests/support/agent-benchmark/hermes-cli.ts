import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AdapterRunInput, TokenUsage, ToolMetrics } from "./contracts.ts";
import { sanitizeIdentifier } from "./identifiers.ts";

export const MAX_HERMES_USAGE_BYTES = 64 * 1024;
const MAX_HERMES_USAGE_NUMBER = 1_000_000_000_000;

/** Bounded, typed fields emitted by Hermes' one-shot --usage-file contract. */
export interface HermesUsageObservation {
  sessionId: string | null;
  model: string | null;
  provider: string | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  apiCalls: number | null;
  completed: boolean | null;
  failed: boolean | null;
  failure: string | null;
}

export interface HermesSessionTelemetry {
  sessionId: string;
  model: string | null;
  provider: string | null;
  usage: TokenUsage;
  tools: ToolMetrics;
}

export function hermesUsagePath(evidenceRoot: string): string {
  return join(evidenceRoot, "hermes-usage.json");
}

/**
 * Parses only the documented scalar Hermes usage fields. Raw JSON is never
 * returned or persisted; malformed, oversized, and unsafe values become null.
 */
export function parseHermesUsageFile(raw: string): HermesUsageObservation {
  const empty = emptyHermesUsage();
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw, "utf8") > MAX_HERMES_USAGE_BYTES) return empty;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty;
  }
  const record = asRecord(value);
  if (!record) return empty;
  return {
    sessionId: normalizeSessionId(record.session_id),
    model: sanitizeIdentifier(record.model),
    provider: sanitizeIdentifier(record.provider),
    inputTokens: boundedUsageNumber(record.input_tokens),
    cacheReadTokens: boundedUsageNumber(record.cache_read_tokens),
    cacheWriteTokens: boundedUsageNumber(record.cache_write_tokens),
    outputTokens: boundedUsageNumber(record.output_tokens),
    totalTokens: boundedUsageNumber(record.total_tokens),
    apiCalls: boundedUsageNumber(record.api_calls),
    completed: typeof record.completed === "boolean" ? record.completed : null,
    failed: typeof record.failed === "boolean" ? record.failed : null,
    failure: safeHermesFailure(record.failure),
  };
}

/**
 * Reads the bounded usage artifact emitted by a Hermes one-shot invocation.
 * The file is consumed and removed immediately; only the typed scalar
 * observation escapes this module.
 */
export function readHermesUsage(path: string): HermesUsageObservation | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_HERMES_USAGE_BYTES) {
      unlinkSync(path);
      return null;
    }
    const parsed = parseHermesUsageFile(readFileSync(path, "utf8"));
    unlinkSync(path);
    return Object.values(parsed).some((value) => value !== null) ? parsed : null;
  } catch {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort cleanup */ }
    return null;
  }
}

export function hermesUsageDiagnosticFor(usage: HermesUsageObservation | null): string | null {
  if (!usage) return "Hermes usage telemetry was missing, malformed, or oversized.";
  if (usage.failed === true || usage.completed !== true || usage.failure !== null) {
    return "Hermes usage telemetry reported an incomplete or failed one-shot.";
  }
  return null;
}

export function hermesCommandFor(input: AdapterRunInput): { args: string[] } {
  const config = input.arm.effectiveConfig;
  if (input.fixture.id === "direct_conversation") {
    const args = ["chat", "-Q"];
    if (input.arm.track === "controlled") {
      if (config.provider) args.push("--provider", config.provider);
      if (config.model) args.push("--model", hermesModelArgument(config.model));
      if (config.reasoning) args.push("--reasoning", config.reasoning);
      args.push("--safe-mode", "--toolsets", "web,file", "--yolo");
    }
    if (input.sessionId) args.push("--resume", input.sessionId);
    // Hermes' -q/--query option consumes the immediately following value.
    // Keep every option, including --resume, before that query pair.
    args.push("-q", input.prompt);
    return { args };
  }
  const args = ["--usage-file", hermesUsagePath(input.arm.evidenceRoot)];
  if (input.arm.track === "controlled") {
    if (config.provider) args.push("--provider", config.provider);
    if (config.model) args.push("--model", hermesModelArgument(config.model));
    if (config.reasoning) args.push("--reasoning", config.reasoning);
    args.push("--safe-mode", "--toolsets", "web,file", "--yolo");
  }
  // Hermes' argparse path treats -z as the one-shot switch and requires its
  // prompt as the immediately following value.
  args.push("-z", input.prompt);
  return { args };
}

/** Reads only the aggregate session row; message/transcript/reasoning columns
 * are deliberately never selected or serialized. */
export function readHermesSessionTelemetry(sessionId: string | null): HermesSessionTelemetry | null {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const home = process.env.HOME;
  const dbPath = home ? join(home, ".hermes", "state.db") : null;
  if (!normalizedSessionId || !dbPath || !existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query(
      "SELECT id, model, billing_provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, api_call_count, tool_call_count FROM sessions WHERE id = ?",
    ).get(normalizedSessionId) as unknown;
    if (!isRecord(row) || row.id !== normalizedSessionId) return null;
    const inputTokens = sqliteNumber(row.input_tokens);
    const outputTokens = sqliteNumber(row.output_tokens);
    return {
      sessionId: normalizedSessionId,
      model: sanitizeIdentifier(row.model),
      provider: sanitizeIdentifier(row.billing_provider),
      usage: {
        inputTokens,
        cacheReadTokens: sqliteNumber(row.cache_read_tokens),
        cacheWriteTokens: sqliteNumber(row.cache_write_tokens),
        outputTokens,
        totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
        modelRequests: sqliteNumber(row.api_call_count),
      },
      tools: {
        calls: sqliteNumber(row.tool_call_count),
        failedCalls: null,
        records: [],
      },
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* best effort for a read-only probe */ }
  }
}

function hermesModelArgument(model: string): string {
  const separator = model.indexOf("/");
  return separator >= 0 ? model.slice(separator + 1) : model;
}

function emptyHermesUsage(): HermesUsageObservation {
  return {
    sessionId: null,
    model: null,
    provider: null,
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    totalTokens: null,
    apiCalls: null,
    completed: null,
    failed: null,
    failure: null,
  };
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{1,160}$/u.test(normalized) ? normalized : null;
}

function boundedUsageNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_HERMES_USAGE_NUMBER
    ? value
    : null;
}

function sqliteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_HERMES_USAGE_NUMBER
    ? value
    : null;
}

function safeHermesFailure(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) return null;
  if ([...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  }) || /[|`]/u.test(normalized) || /(?:api[_-]?key|token|password|secret)\s*[:=]|(?:\/Users\/|\/home\/|[A-Z]:\\)/iu.test(normalized)) return null;
  return normalized.replace(/\$1/gu, "[REDACTED]");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== null;
}
