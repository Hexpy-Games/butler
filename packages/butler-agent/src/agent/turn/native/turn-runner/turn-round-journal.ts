import { createHash } from "crypto";
import { safeOptionalPublicText, safeRelativePath } from "../../../output/evidence/transcript-sanitizers.ts";
import { isStateMutatingToolCall } from "../../tool-loop-guards.ts";
import { structuredToolResultModelPreview } from "../../tool-result-model-preview.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import {
  recentTurnRoundJournal,
  type DurableTurnRoundJournalEntry,
} from "../../turn-round-journal-contract.ts";

export type { DurableTurnRoundJournalEntry } from "../../turn-round-journal-contract.ts";

export function buildTurnRoundJournal(input: {
  audit: readonly ToolAuditEntry[];
  publicDecisions: readonly PublicWorkDecision[];
}): DurableTurnRoundJournalEntry[] {
  return recentTurnRoundJournal(buildDurableTurnRoundJournal(input));
}

export function buildDurableTurnRoundJournal(input: {
  audit: readonly ToolAuditEntry[];
  publicDecisions: readonly PublicWorkDecision[];
}): DurableTurnRoundJournalEntry[] {
  return input.audit.map((entry, offset) => {
    const decision = entry.publicDecision ?? decisionForAuditEntry(input.publicDecisions, entry);
    const resultPreview = structuredToolResultModelPreview({
      toolName: entry.name,
      output: entry.result ?? entry.observation ?? entry.error,
    });
    const mutating = entry.ok && isStateMutatingToolCall(entry.name, entry.args);
    const evidence = entry.ok && (
      (entry.evidenceReceipts?.length ?? 0) > 0 ||
      (entry.evidenceCapabilityReceipts?.length ?? 0) > 0
    );
    return compactUndefined({
      sequence: offset + 1,
      decision_id: safeText(decision?.decisionId),
      semantic_block_id: safeText(decision?.semanticBlockId),
      block_title: safeOptionalPublicText(decision?.blockTitle),
      expected_effect: safeOptionalPublicText(decision?.expectedEffect),
      repeat_reason: decision?.repeatReason,
      tool: safeToolName(entry.name),
      ok: entry.ok,
      call_identity: digest(stableJson({ tool: entry.name, args: stableValue(entry.args) })),
      result_fingerprint: digest(stableJson(stableValue(resultPreview ?? entry.result ?? entry.error))),
      state_revision: stateRevision(entry, resultPreview),
      observed_delta: mutating ? "mutation" : evidence ? "evidence" : "none",
      result_preview: resultPreview ?? undefined,
    }) as unknown as DurableTurnRoundJournalEntry;
  });
}

export function renderTurnRoundJournal(entries: readonly DurableTurnRoundJournalEntry[]): string {
  if (entries.length === 0) return "";
  return [
    "Recent provider-neutral round journal:",
    JSON.stringify(entries, null, 2),
    "Use changed state revisions and unresolved obligations to choose the next action. Do not repeat a no-delta broad read unless a typed retry reason expects a concrete change.",
  ].join("\n");
}

function decisionForAuditEntry(
  decisions: readonly PublicWorkDecision[],
  entry: ToolAuditEntry,
): PublicWorkDecision | undefined {
  return [...decisions].reverse().find((decision) =>
    !decision.toolName || decision.toolName === entry.name,
  );
}

function stateRevision(
  entry: ToolAuditEntry,
  preview: Record<string, unknown> | null,
): string {
  const receiptIds = [
    ...(entry.evidenceReceipts ?? []).map((receipt) => receipt.id),
    ...(entry.evidenceCapabilityReceipts ?? []).map((receipt) => receipt.receipt_id),
  ].filter(Boolean).sort();
  return digest(stableJson({
    tool: entry.name,
    ok: entry.ok,
    receipts: receiptIds,
    preview: stableValue(preview),
  }));
}

function stableValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 5) return "[bounded]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (/path/iu.test(key)) return safeRelativePath(value) ?? "[private-path]";
    return safeOptionalPublicText(value)?.slice(0, 600) ?? "";
  }
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => stableValue(item, key, depth + 1));
  if (!value || typeof value !== "object") return String(value ?? "");
  const volatile = new Set([
    "created_at", "createdAt", "updated_at", "updatedAt", "generatedAt", "timestamp",
    "public_work_decision_context", "raw", "body", "content", "prompt", "arguments",
  ]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([childKey]) => !volatile.has(childKey))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([childKey, childValue]) => [childKey, stableValue(childValue, childKey, depth + 1)]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeText(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,180}$/u.test(value)
    ? value
    : undefined;
}

function safeToolName(value: string): string {
  return /^[A-Za-z0-9._:-]{1,120}$/u.test(value) ? value : "tool";
}

function compactUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
