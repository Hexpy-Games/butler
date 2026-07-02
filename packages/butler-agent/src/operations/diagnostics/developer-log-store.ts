import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  InboundEnvelope,
  RuntimeTurnResult,
  StoredSessionBinding,
} from "../../test-support/harness/contracts.ts";
import type {
  ContextAssembly,
  ContextReference,
  ContextRegion,
  PromptSection,
} from "../../agent/prompt/prompt-assembler.ts";
import type { GatewayRoute } from "../../gateways/core/contracts.ts";

export const DEVELOPER_LOG_SCHEMA = "butler.developer-log.v1";
export const DEVELOPER_LOG_MAX_ENTRIES = 500;
export const DEVELOPER_LOG_REGION_ORDER = [
  "static_context",
  "live_configuration",
  "runtime_state",
  "working_context",
  "retrieved_context",
  "current_input",
] as const satisfies readonly ContextRegion[];

export type DeveloperLogKind = "model_turn";

export interface DeveloperLogSection {
  id: string;
  title: string;
  region: ContextRegion | "unknown";
  char_count: number;
  content: string;
}

export interface DeveloperLogEntry {
  schema: typeof DEVELOPER_LOG_SCHEMA;
  id: string;
  kind: DeveloperLogKind;
  created_at: string;
  session_id: string;
  turn_id: string | null;
  role: StoredSessionBinding["role"];
  transport: string;
  route: {
    session_id: string | null;
    role: string | null;
    reason: string | null;
    project_id: string | null;
  };
  model: {
    requested_model_ref: string;
    provider_id: string | null;
    runtime_adapter_id: string | null;
  };
  context: {
    live_config_hash: string | null;
    region_order: typeof DEVELOPER_LOG_REGION_ORDER;
    sections: DeveloperLogSection[];
    references: ContextReference[];
    prompt_context: string;
  };
  request: {
    input_text: string;
    metadata: Record<string, unknown>;
  };
  response: {
    text: string;
    raw: unknown;
  };
  privacy: {
    raw_text_included: true;
    secrets_redacted: true;
    local_only: true;
  };
}

export interface DeveloperLogListOptions {
  limit?: number;
  offset?: number;
  sessionId?: string;
  turnId?: string;
  kind?: DeveloperLogKind;
  query?: string;
}

export interface DeveloperLogListResult {
  entries: DeveloperLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface DeveloperLogTurnCaptureInput {
  binding: StoredSessionBinding;
  envelope: InboundEnvelope;
  route?: GatewayRoute;
  contextAssembly?: ContextAssembly;
  promptContext?: string;
  result: RuntimeTurnResult;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

const SECRET_FIELD_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|authorization|credential|session[_-]?key)/iu;
const BEARER_PATTERN = /\bbearer\s+[\w.~+/=-]+/giu;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization|credential|session[_-]?key)\s*[:=]\s*(?:bearer\s+)?\S+/giu;
const ENV_SECRET_ASSIGNMENT_PATTERN =
  /\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|PASSWORD|SECRET)[A-Z0-9_]*\s*[:=]\s*\S+/giu;

function developerLogPath(butlerData: string): string {
  return join(butlerData, "app", "developer-logs", "model-turns.jsonl");
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(100, Math.trunc(value ?? 50)));
}

function clampOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value ?? 0));
}

function redactedString(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT_PATTERN, "[REDACTED]")
    .replace(ENV_SECRET_ASSIGNMENT_PATTERN, "[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]");
}

function redactedJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactedString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactedJsonValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_FIELD_PATTERN.test(key)
      ? "[REDACTED]"
      : redactedJsonValue(item, seen);
  }
  return output;
}

function safeRecord(value: unknown): Record<string, unknown> {
  const redacted = redactedJsonValue(value);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

function sectionsFromAssembly(assembly?: ContextAssembly): DeveloperLogSection[] {
  if (!assembly) return [];
  const sectionsByRegion = [
    ...assembly.staticContext,
    ...assembly.liveConfiguration,
    ...assembly.runtimeState,
    ...assembly.workingContext,
    ...assembly.retrievedContext,
    ...assembly.currentInput,
  ];
  return sectionsByRegion.map((section) => sectionFromPromptSection(section));
}

function sectionFromPromptSection(section: PromptSection): DeveloperLogSection {
  const content = redactedString(section.content);
  return {
    id: section.id,
    title: section.title,
    region: section.region ?? "unknown",
    char_count: content.length,
    content,
  };
}

function turnIdFromEnvelope(envelope: InboundEnvelope): string | null {
  return envelope.routingHints?.turnId?.trim() || null;
}

function routeSummary(route?: GatewayRoute): DeveloperLogEntry["route"] {
  return {
    session_id: route?.sessionId ?? null,
    role: route?.role ?? null,
    reason: route?.reason ?? null,
    project_id: route?.projectId ?? null,
  };
}

function redactedReferences(references: ContextReference[] | undefined): ContextReference[] {
  return (references ?? []).map((reference) => ({
    ...reference,
    label: reference.label ? redactedString(reference.label) : reference.label,
    metadata: reference.metadata
      ? safeRecord(reference.metadata)
      : reference.metadata,
  }));
}

function searchableText(entry: DeveloperLogEntry): string {
  return [
    entry.id,
    entry.kind,
    entry.session_id,
    entry.turn_id,
    entry.transport,
    entry.model.requested_model_ref,
    entry.model.provider_id,
    entry.model.runtime_adapter_id,
    entry.route.reason,
    entry.route.project_id,
    entry.response.text,
    ...entry.context.sections.flatMap((section) => [
      section.id,
      section.title,
      section.region,
    ]),
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n")
    .toLocaleLowerCase("en-US");
}

function matchesEntry(entry: DeveloperLogEntry, options: DeveloperLogListOptions): boolean {
  if (options.kind && entry.kind !== options.kind) return false;
  if (options.sessionId && entry.session_id !== options.sessionId) return false;
  if (options.turnId && entry.turn_id !== options.turnId) return false;
  const query = options.query?.trim().toLocaleLowerCase("en-US");
  return !query || searchableText(entry).includes(query);
}

function parseEntry(line: string): DeveloperLogEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isDeveloperLogEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isDeveloperLogEntry(value: unknown): value is DeveloperLogEntry {
  if (!isRecord(value)) return false;
  if (value.schema !== DEVELOPER_LOG_SCHEMA || value.kind !== "model_turn") return false;
  return (
    typeof value.id === "string" &&
    typeof value.created_at === "string" &&
    typeof value.session_id === "string" &&
    (typeof value.turn_id === "string" || value.turn_id === null) &&
    typeof value.role === "string" &&
    typeof value.transport === "string" &&
    isRoute(value.route) &&
    isModel(value.model) &&
    isContext(value.context) &&
    isRequest(value.request) &&
    isResponse(value.response) &&
    isPrivacy(value.privacy)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isRoute(value: unknown): value is DeveloperLogEntry["route"] {
  return isRecord(value) &&
    isNullableString(value.session_id) &&
    isNullableString(value.role) &&
    isNullableString(value.reason) &&
    isNullableString(value.project_id);
}

function isModel(value: unknown): value is DeveloperLogEntry["model"] {
  return isRecord(value) &&
    typeof value.requested_model_ref === "string" &&
    isNullableString(value.provider_id) &&
    isNullableString(value.runtime_adapter_id);
}

function isContext(value: unknown): value is DeveloperLogEntry["context"] {
  if (!isRecord(value)) return false;
  return (
    isNullableString(value.live_config_hash) &&
    Array.isArray(value.region_order) &&
    value.region_order.every((region) => typeof region === "string") &&
    Array.isArray(value.sections) &&
    value.sections.every(isSection) &&
    Array.isArray(value.references) &&
    typeof value.prompt_context === "string"
  );
}

function isSection(value: unknown): value is DeveloperLogSection {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.region === "string" &&
    typeof value.char_count === "number" &&
    typeof value.content === "string";
}

function isRequest(value: unknown): value is DeveloperLogEntry["request"] {
  return isRecord(value) &&
    typeof value.input_text === "string" &&
    isRecord(value.metadata);
}

function isResponse(value: unknown): value is DeveloperLogEntry["response"] {
  return isRecord(value) && typeof value.text === "string" && "raw" in value;
}

function isPrivacy(value: unknown): value is DeveloperLogEntry["privacy"] {
  return isRecord(value) &&
    value.raw_text_included === true &&
    value.secrets_redacted === true &&
    value.local_only === true;
}

export class DeveloperLogStore {
  private readonly path: string;

  constructor(input: { butlerData: string; path?: string }) {
    this.path = input.path ?? developerLogPath(input.butlerData);
  }

  appendModelTurn(input: DeveloperLogTurnCaptureInput): DeveloperLogEntry {
    const entry: DeveloperLogEntry = {
      schema: DEVELOPER_LOG_SCHEMA,
      id: `devlog-${randomUUID()}`,
      kind: "model_turn",
      created_at: input.timestamp,
      session_id: input.binding.sessionId,
      turn_id: turnIdFromEnvelope(input.envelope),
      role: input.binding.role,
      transport: input.envelope.transport,
      route: routeSummary(input.route),
      model: {
        requested_model_ref: input.binding.modelRef,
        provider_id: input.binding.modelProviderId ?? null,
        runtime_adapter_id: input.binding.runtimeAdapterId ?? null,
      },
      context: {
        live_config_hash: input.contextAssembly?.liveConfigHash ?? null,
        region_order: DEVELOPER_LOG_REGION_ORDER,
        sections: sectionsFromAssembly(input.contextAssembly),
        references: redactedReferences(input.contextAssembly?.references),
        prompt_context: redactedString(input.promptContext ?? ""),
      },
      request: {
        input_text: redactedString(input.envelope.message.text?.trim() ?? ""),
        metadata: safeRecord(input.metadata),
      },
      response: {
        text: redactedString(input.result.text),
        raw: redactedJsonValue(input.result.raw ?? null),
      },
      privacy: {
        raw_text_included: true,
        secrets_redacted: true,
        local_only: true,
      },
    };

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    this.secureFileMode();
    this.enforceRetention();
    return entry;
  }

  list(options: DeveloperLogListOptions = {}): DeveloperLogListResult {
    const limit = clampLimit(options.limit);
    const offset = clampOffset(options.offset);
    const entries = this.readAll()
      .filter((entry) => matchesEntry(entry, options))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    return {
      entries: entries.slice(offset, offset + limit),
      total: entries.length,
      limit,
      offset,
    };
  }

  private readAll(): DeveloperLogEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseEntry)
      .filter((entry): entry is DeveloperLogEntry => Boolean(entry));
  }

  private enforceRetention(): void {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= DEVELOPER_LOG_MAX_ENTRIES) return;
    writeFileSync(
      this.path,
      `${lines.slice(-DEVELOPER_LOG_MAX_ENTRIES).join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    this.secureFileMode();
  }

  private secureFileMode(): void {
    try {
      chmodSync(dirname(this.path), 0o700);
      chmodSync(this.path, 0o600);
    } catch {
      // Best-effort local privacy hardening; write failures are surfaced elsewhere.
    }
  }
}
