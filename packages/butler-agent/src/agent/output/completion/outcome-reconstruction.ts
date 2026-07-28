import { extname } from "node:path";
import { sanitizePublicText } from "../../events/turn-events.ts";
import type { ToolAuditEntry } from "../../tool-support/index.ts";
import { createEvidenceCapabilityReceipt } from "../evidence/ledger.ts";
import type {
  EvidenceCapabilityReceipt,
  EvidenceCapabilityReference,
} from "../evidence/types.ts";

const MAX_RECONSTRUCTED_REFERENCES = 8;

export function reconstructDurableOutcomeReceiptsFromAuditEntry(
  entry: ToolAuditEntry,
): EvidenceCapabilityReceipt[] {
  if (!entry.ok) return [];
  const result = recordValue(entry.result);
  if (!result) return [];
  const references = reconstructedOutcomeReferences(result);
  if (references.length === 0) return [];
  const receipts: EvidenceCapabilityReceipt[] = [];
  const common = {
    producer: { kind: "runtime" as const, name: "durable_outcome_reconstruction" },
    references,
    scope: {
      source_tool: entry.name,
      reconstructed: true,
    },
    created_at: new Date().toISOString(),
  };
  const durableOutcome = hasDurableOutcomeSignal(result);
  if (durableOutcome) {
    receipts.push(createEvidenceCapabilityReceipt({
      ...common,
      capability: "durable_artifact",
      evidence_kind: "artifact",
      confidence: 0.82,
      summary: "Recovered durable outcome evidence from safe tool result references.",
      satisfies: ["durable_artifact"],
      limitations: ["Recovered from tool result references because a source receipt was incomplete."],
    }));
  }
  if (hasTableOutcomeSignal(result, references, durableOutcome)) {
    receipts.push(createEvidenceCapabilityReceipt({
      ...common,
      capability: "data_table_created",
      evidence_kind: "data_table",
      confidence: 0.82,
      summary: "Recovered table outcome evidence from safe tool result references.",
      satisfies: ["data_table_created"],
      limitations: ["Recovered from tool result references because a source receipt was incomplete."],
    }));
  }
  if (hasChartOutcomeSignal(result, references, durableOutcome)) {
    receipts.push(createEvidenceCapabilityReceipt({
      ...common,
      capability: "chart_rendered",
      evidence_kind: "chart",
      confidence: 0.82,
      summary: "Recovered chart outcome evidence from safe tool result references.",
      satisfies: ["chart_rendered"],
      limitations: ["Recovered from tool result references because a source receipt was incomplete."],
    }));
  }
  return receipts;
}

function reconstructedOutcomeReferences(result: Record<string, unknown>): EvidenceCapabilityReference[] {
  const references: EvidenceCapabilityReference[] = [];
  const add = (value: unknown) => {
    if (references.length >= MAX_RECONSTRUCTED_REFERENCES) return;
    const text = safeReferenceText(value);
    if (!text) return;
    references.push({ label: text, path: text });
  };
  for (const value of [
    result.written_file,
    result.artifact_label,
    result.output_label,
    result.file_label,
    result.patch_result,
  ]) {
    add(value);
  }
  for (const value of [
    result.written_files,
    result.artifact_labels,
    result.output_paths,
    result.verified_output_files,
  ]) {
    for (const item of referenceValues(value)) add(item);
  }
  return uniqueReferences(references);
}

function referenceValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(referenceValues);
  const record = recordValue(value);
  if (record) return [record.path ?? record.label ?? record.artifact_label ?? record.file_path];
  return [value];
}

function uniqueReferences(references: EvidenceCapabilityReference[]): EvidenceCapabilityReference[] {
  const seen = new Set<string>();
  const unique: EvidenceCapabilityReference[] = [];
  for (const reference of references) {
    const key = reference.path ?? reference.label ?? "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(reference);
  }
  return unique.slice(0, MAX_RECONSTRUCTED_REFERENCES);
}

function hasDurableOutcomeSignal(result: Record<string, unknown>): boolean {
  return result.durable_artifact_created === true ||
    result.created === true ||
    result.overwritten === true ||
    referenceValues(result.verified_output_files).some((value) => safeReferenceText(value));
}

function hasTableOutcomeSignal(
  result: Record<string, unknown>,
  references: EvidenceCapabilityReference[],
  durableOutcome: boolean,
): boolean {
  if (result.data_table_created === true) return true;
  if (!durableOutcome) return false;
  return (
    stringValue(result.artifact_kind) === "csv_file" ||
    stringValue(result.artifact_kind) === "table_file" ||
    arrayIncludes(result.artifact_kinds, ["csv_file", "table_file"]) ||
    references.some((reference) => {
      const ext = extname(reference.path ?? reference.label ?? "").toLocaleLowerCase("en-US");
      return ext === ".csv" || ext === ".tsv";
    })
  );
}

function hasChartOutcomeSignal(
  result: Record<string, unknown>,
  references: EvidenceCapabilityReference[],
  durableOutcome: boolean,
): boolean {
  if (result.chart_rendered === true) return true;
  if (!durableOutcome) return false;
  return (
    stringValue(result.artifact_kind) === "chart_file" ||
    arrayIncludes(result.artifact_kinds, ["chart_file"]) ||
    references.some((reference) =>
      [".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf"].includes(
        extname(reference.path ?? reference.label ?? "").toLocaleLowerCase("en-US"),
      ),
    )
  );
}

function safeReferenceText(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:[\\/]/u.test(raw)) return null;
  if (raw.split(/[\\/]+/u).includes("..")) return null;
  if (/\b(?:authorization|bearer|token|secret|api[_-]?key)\b/iu.test(raw)) return null;
  const safe = sanitizePublicText(raw, "");
  return safe && safe === raw ? safe.slice(0, 240) : null;
}

function arrayIncludes(value: unknown, candidates: string[]): boolean {
  return Array.isArray(value) && value.some((item) =>
    typeof item === "string" && candidates.includes(item));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
