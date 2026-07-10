import { randomUUID } from "crypto";
import { sanitizePublicText } from "../../events/turn-events.ts";
import type { PublicWorkObligationKind } from "../../turn/native/output/tool-types.ts";

const DECISION_ID_SUFFIX_LENGTH = 8;
const PUBLIC_DECISION_TEXT_MAX_CHARS = 420;
const PUBLIC_DECISION_RECORD_LIMIT = 6;
const PUBLIC_DECISION_MIN_CHARS = 8;
const PUBLIC_DECISION_MIN_UNIQUE_CHARS = 3;
const PUBLIC_WORK_DECISION_CONTEXT_LIMIT = 6;
const PUBLIC_WORK_DECISION_CONTEXT_REF_LIMIT = 3;
const PUBLIC_WORK_OBLIGATION_LIMIT = 6;

const PUBLIC_WORK_DECISION_PROTOCOL_FIELDS = {
  title: "blockTitle",
  summary: "summary",
  rationale: "rationale",
  next_step: "nextStep",
  completion_obligations: "completionObligations",
} as const;

const PUBLIC_WORK_OBLIGATION_KINDS = new Set<PublicWorkObligationKind>([
  "source_verified",
  "command_executed",
  "durable_artifact",
  "data_table_created",
  "chart_rendered",
]);

export interface PublicDecisionStructuredFields {
  blockTitle?: string;
  summary?: string;
  rationale?: string;
  nextStep?: string;
  completionObligations?: PublicWorkObligationKind[];
  repaired?: boolean;
}

export function publicDecisionId(): string {
  return `decision-${randomUUID().slice(0, DECISION_ID_SUFFIX_LENGTH)}`;
}

export function publicDecisionText(value: string): string {
  const sanitized = sanitizePublicText(value, "");
  if (!sanitized) {
    return "";
  }
  if (sanitized.length > PUBLIC_DECISION_TEXT_MAX_CHARS) {
    return sanitized.slice(0, PUBLIC_DECISION_TEXT_MAX_CHARS);
  }
  return sanitized;
}

export function publicDecisionStructuredFields(value: string): PublicDecisionStructuredFields[] {
  const decisions: PublicDecisionStructuredFields[] = [];
  let current: PublicDecisionStructuredFields = {};
  for (const rawLine of value.split(/\n+/u)) {
    const line = rawLine.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, "").trim();
    if (!line) {
      continue;
    }
    const parsed = parseDecisionProtocolLine(line);
    if (!parsed) {
      continue;
    }
    if (parsed.key === "blockTitle") {
      if (current.blockTitle || current.summary || current.rationale || current.nextStep) {
        decisions.push(current);
        current = {};
      }
      current = assignProtocolText(current, "blockTitle", parsed.value);
      continue;
    }
    if (parsed.key === "summary") {
      if (current.summary) {
        decisions.push(current);
        current = {};
      }
      current = assignProtocolText(current, "summary", parsed.value);
      continue;
    }
    if (parsed.key === "rationale") {
      current = assignProtocolText(current, "rationale", parsed.value);
      continue;
    }
    if (parsed.key === "nextStep") {
      current = assignProtocolText(current, "nextStep", parsed.value);
      continue;
    }
    const obligations = publicDecisionCompletionObligations(parsed.value);
    if (obligations.length > 0) {
      current.completionObligations = obligations;
    } else {
      current.repaired = true;
    }
  }
  if (current.blockTitle || current.summary || current.rationale || current.nextStep) {
    decisions.push(current);
  }
  return decisions.slice(0, PUBLIC_DECISION_RECORD_LIMIT);
}

export function isUsablePublicDecisionText(
  value: string,
  options: { minChars?: number } = {},
): boolean {
  const text = sanitizePublicText(value, "").trim();
  const minChars = options.minChars ?? PUBLIC_DECISION_MIN_CHARS;
  if (text.length < minChars) {
    return false;
  }
  const compact = text.replace(/\s+/gu, "");
  if (new Set(Array.from(compact)).size < PUBLIC_DECISION_MIN_UNIQUE_CHARS) {
    return false;
  }
  return true;
}

export function renderPublicDecisionContext(input: Array<{
  blockTitle?: string;
  summary: string;
  rationale?: string;
  nextStep?: string;
  completionObligations?: PublicWorkObligationKind[];
  evidenceRefs: string[];
}>): string {
  const recent = input.slice(-PUBLIC_WORK_DECISION_CONTEXT_LIMIT);
  if (recent.length === 0) {
    return "";
  }
  return [
    "## Public Work Decisions",
    ...recent.map((decision, index) => {
      const parts = [
        `${index + 1}. ${decision.blockTitle ? `[${decision.blockTitle}] ` : ""}${decision.summary}`,
        decision.rationale ? `rationale: ${decision.rationale}` : "",
        decision.nextStep ? `next_step: ${decision.nextStep}` : "",
        decision.completionObligations && decision.completionObligations.length > 0
          ? `completion_obligations: ${decision.completionObligations.join(", ")}`
          : "",
        decision.evidenceRefs.length > 0
          ? `refs: ${decision.evidenceRefs.slice(0, PUBLIC_WORK_DECISION_CONTEXT_REF_LIMIT).join("; ")}`
          : "",
      ].filter(Boolean);
      return parts.join(" | ");
    }),
  ].join("\n");
}

function parseDecisionProtocolLine(
  line: string,
): { key: "blockTitle" | "summary" | "rationale" | "nextStep" | "completionObligations"; value: string } | null {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex < 0) {
    return null;
  }
  const rawKey = line.slice(0, separatorIndex).trim();
  const field = PUBLIC_WORK_DECISION_PROTOCOL_FIELDS[
    rawKey as keyof typeof PUBLIC_WORK_DECISION_PROTOCOL_FIELDS
  ];
  if (!field) {
    return null;
  }
  return {
    key: field,
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function assignProtocolText<T extends "blockTitle" | "summary" | "rationale" | "nextStep">(
  current: PublicDecisionStructuredFields,
  key: T,
  value: string,
): PublicDecisionStructuredFields {
  const text = publicDecisionText(value);
  if (!text) {
    return { ...current, repaired: true };
  }
  return { ...current, [key]: text };
}

function publicDecisionCompletionObligations(value: string): PublicWorkObligationKind[] {
  const seen = new Set<PublicWorkObligationKind>();
  for (const raw of value.split(/[, ]+/u)) {
    const normalized = raw.trim().toLowerCase().replace(/[^a-z_]/gu, "");
    if (!PUBLIC_WORK_OBLIGATION_KINDS.has(normalized as PublicWorkObligationKind)) {
      continue;
    }
    seen.add(normalized as PublicWorkObligationKind);
  }
  return Array.from(seen).slice(0, PUBLIC_WORK_OBLIGATION_LIMIT);
}
