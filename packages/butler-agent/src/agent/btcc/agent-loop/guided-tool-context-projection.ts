import type { GuidedToolJournalRecord } from "../ports/index.ts";
import { digest } from "../identity/index.ts";
import { structuredToolResultModelPreview } from
  "../../tools/tool-result-model-preview.ts";

const DEFAULT_MAX_RECORDS = 12;
const DEFAULT_MAX_RECORD_BYTES = 6_000;
const DEFAULT_MAX_TOTAL_BYTES = 20_000;
const MAX_GENERIC_STRING_CHARS = 480;
const MAX_COLLECTION_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 6;

type ProjectionOptions = {
  maxRecords?: number;
  maxRecordBytes?: number;
  maxTotalBytes?: number;
};

export function projectGuidedToolContext(
  records: readonly GuidedToolJournalRecord[],
  options: ProjectionOptions = {},
): Array<Record<string, unknown>> {
  const maxRecords = positive(options.maxRecords, DEFAULT_MAX_RECORDS);
  const maxRecordBytes = positive(
    options.maxRecordBytes,
    DEFAULT_MAX_RECORD_BYTES,
  );
  const maxTotalBytes = positive(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
  );
  if (maxTotalBytes < 2) return [];

  const result: Array<Record<string, unknown>> = [];
  let totalBytes = 2;
  for (const record of [...records].reverse().slice(0, maxRecords)) {
    const separatorBytes = result.length > 0 ? 1 : 0;
    const available = Math.min(
      maxRecordBytes,
      maxTotalBytes - totalBytes - separatorBytes,
    );
    if (available <= 0) break;
    const bounded = fitRecord(projectRecord(record), available);
    if (!bounded) continue;
    result.push(bounded.value);
    totalBytes += separatorBytes + bounded.bytes;
  }
  return result;
}

function projectRecord(record: GuidedToolJournalRecord): Record<string, unknown> {
  const layers = resultLayers(record.result);
  const facts = latestResultFacts(record, layers);
  const preview = structuredToolResultModelPreview({
    toolName: record.toolName,
    output: record.result,
  });
  const resultPreview = preview ? omitControlFields(preview) : null;
  return compact({
    tool_name: record.toolName,
    status: record.status,
    arguments: projectValue(modelVisibleArguments(record), 0),
    result_sha256: record.resultSha256,
    result_preview: resultPreview && Object.keys(resultPreview).length > 0
      ? resultPreview
      : undefined,
    ...facts,
  });
}

function modelVisibleArguments(
  record: GuidedToolJournalRecord,
): Record<string, unknown> {
  const result = { ...record.arguments };
  if (record.toolName === "write_file" || record.toolName === "edit_file") {
    delete result.expected_sha256;
  }
  if (record.toolName === "write_file") delete result.overwrite;
  return result;
}

function latestResultFacts(
  record: GuidedToolJournalRecord,
  layers: readonly Record<string, unknown>[],
): Record<string, unknown> {
  let error: Record<string, unknown> | undefined;
  let effectStatus: string | undefined;
  let effectReceipt: Record<string, unknown> | undefined;
  for (const layer of layers) {
    const layerError = asRecord(layer.error);
    const layerErrorText = boundedSemanticString(layer.error, 1_200);
    if (!error && (layerError || layerErrorText)) {
      error = compact({
        code: boundedSemanticString(
          layerError?.code ?? layer.code ?? record.errorCode,
          160,
        ),
        message: boundedSemanticString(layerError?.message, 1_200) ??
          layerErrorText,
        recoverable: booleanValue(layerError?.recoverable) ??
          booleanValue(layer.recoverable),
        next_action: semanticValue(
          layerError?.next_action ?? layer.next_action,
        ),
      });
    }
    effectStatus ??= boundedSemanticString(layerError?.effect_status, 120) ??
      boundedSemanticString(layer.effect_status, 120);
    const receipt = asRecord(layer.effect_receipt);
    if (!effectReceipt && receipt) {
      effectReceipt = compact({
        capability: boundedSemanticString(receipt.capability, 160),
        target: boundedSemanticString(receipt.target, 800),
        applied_at: boundedSemanticString(receipt.applied_at, 80),
        replayed: booleanValue(receipt.replayed),
      });
    }
  }
  return compact({
    error: error ?? (record.errorCode
      ? { code: boundedSemanticString(record.errorCode, 160) }
      : undefined),
    effect_status: effectStatus ?? (effectReceipt ? "applied" : undefined),
    effect_receipt: effectReceipt,
  });
}

function omitControlFields(preview: Record<string, unknown>): Record<string, unknown> {
  const result = { ...preview };
  for (const key of [
    "tool_name",
    "error",
    "recoverable",
    "next_action",
    "effect_status",
    "effect_receipt",
  ]) delete result[key];
  return result;
}

function projectValue(value: unknown, depth: number, key = ""): unknown {
  if (value === null || typeof value === "boolean" ||
      typeof value === "number") return value;
  if (typeof value === "string") {
    return key === "path" || value.length <= MAX_GENERIC_STRING_CHARS
      ? value
      : { chars: value.length, sha256: digest(value) };
  }
  if (depth >= MAX_DEPTH) return jsonDigest(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => projectValue(item, depth + 1));
    return items.length === value.length
      ? items
      : { items, total_items: value.length, sha256: digest(safeJson(value)) };
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const keys = Object.keys(record).sort();
  const result = Object.fromEntries(
    keys.slice(0, MAX_OBJECT_KEYS).flatMap((childKey) => {
      const child = projectValue(record[childKey], depth + 1, childKey);
      return child === undefined ? [] : [[childKey, child]];
    }),
  );
  if (keys.length > MAX_OBJECT_KEYS) {
    result.omitted_keys = keys.length - MAX_OBJECT_KEYS;
    result.sha256 = digest(safeJson(value));
  }
  return result;
}

function fitRecord(
  value: Record<string, unknown>,
  maxBytes: number,
): { value: Record<string, unknown>; bytes: number } | null {
  let encoded = encode(value);
  if (encoded.bytes <= maxBytes) return encoded;

  const resultCompacted: Record<string, unknown> = {
    ...value,
    ...(value.result_preview === undefined
      ? {}
      : { result_preview: jsonDigest(value.result_preview) }),
  };
  encoded = encode(resultCompacted);
  if (encoded.bytes <= maxBytes) return encoded;

  const argumentsRecord = asRecord(resultCompacted.arguments) ?? {};
  const preservedArguments = Object.fromEntries(
    ["path", "create_parents", "id", "kind", "project_ref"]
      .filter((key) => argumentsRecord[key] !== undefined)
      .map((key) => [key, argumentsRecord[key]]),
  );
  encoded = encode({
    ...resultCompacted,
    arguments: {
      ...preservedArguments,
      omitted_arguments: jsonDigest(argumentsRecord),
    },
  });
  return encoded.bytes <= maxBytes ? encoded : null;
}

function resultLayers(value: unknown): Record<string, unknown>[] {
  const layers: Record<string, unknown>[] = [];
  let current = asRecord(value);
  for (let depth = 0; current && depth < 4; depth += 1) {
    layers.push(current);
    current = asRecord(current.result) ?? asRecord(current.output);
  }
  return layers;
}

function semanticValue(value: unknown): unknown {
  return typeof value === "string"
    ? boundedSemanticString(value, 800)
    : projectValue(value, 0);
}

function boundedSemanticString(
  value: unknown,
  maxChars: number,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length <= maxChars) return value;
  const marker = `\n...[${value.length - maxChars} chars omitted]...\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-Math.floor(available / 2))}`;
}

function jsonDigest(value: unknown): { bytes: number; sha256: string } {
  const encoded = safeJson(value);
  return { bytes: Buffer.byteLength(encoded, "utf8"), sha256: digest(encoded) };
}

function encode(value: Record<string, unknown>): {
  value: Record<string, unknown>;
  bytes: number;
} {
  return { value, bytes: Buffer.byteLength(JSON.stringify(value), "utf8") };
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}
