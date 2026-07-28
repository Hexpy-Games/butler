import { sanitizePublicText } from "../../events/turn-events.ts";
import type { PublicWorkObligationKind } from "../../tool-support/index.ts";
import type {
  EvidenceCapabilityReceipt,
  EvidenceCapabilityReceiptIssue,
  EvidenceCapabilityReference,
} from "./types.ts";

const OBLIGATION_POLICY: Record<PublicWorkObligationKind, Array<{
  capability: EvidenceCapabilityReceipt["capability"];
  evidenceKinds: EvidenceCapabilityReceipt["evidence_kind"][];
}>> = {
  source_verified: [
    { capability: "source_verified", evidenceKinds: ["source_page", "workspace_inspection", "project_state"] },
  ],
  command_executed: [
    { capability: "command_executed", evidenceKinds: ["execution_result"] },
  ],
  durable_artifact: [
    { capability: "durable_artifact", evidenceKinds: ["artifact"] },
  ],
  data_table_created: [
    { capability: "data_table_created", evidenceKinds: ["data_table", "artifact"] },
  ],
  chart_rendered: [
    { capability: "chart_rendered", evidenceKinds: ["chart", "artifact"] },
  ],
};

export function unsupportedSatisfiesIssues(input: {
  capability: EvidenceCapabilityReceipt["capability"] | null;
  evidenceKind: EvidenceCapabilityReceipt["evidence_kind"] | null;
  references: EvidenceCapabilityReference[];
  satisfies: PublicWorkObligationKind[];
}): EvidenceCapabilityReceiptIssue[] {
  if (!input.capability || !input.evidenceKind) return [];
  return input.satisfies
    .filter((obligation) => !receiptSupportsObligation({
      capability: input.capability!,
      evidenceKind: input.evidenceKind!,
      references: input.references,
      obligation,
    }))
    .map((obligation) => ({
      field: "satisfies",
      code: "satisfies_not_supported_by_capability",
      message: `Capability ${input.capability} with ${input.evidenceKind} cannot satisfy ${obligation}.`,
    }));
}

export function safeEvidenceReference(input: {
  index: number;
  record: Record<string, unknown>;
}): { reference: EvidenceCapabilityReference | null; issues: EvidenceCapabilityReceiptIssue[] } {
  const issues: EvidenceCapabilityReceiptIssue[] = [];
  const reference: EvidenceCapabilityReference = {};
  const rawLabel = stringValue(input.record.label);
  const label = safeReferenceText(input.record.label);
  if (label) reference.label = label;
  if (rawLabel && !label) {
    issues.push(issue(`references.${input.index}.label`, "unsafe_reference_text", "Reference text is not public-safe."));
  }
  const url = safeUrl(input.record.url);
  if (url) reference.url = url;
  if (input.record.url !== undefined && !url) {
    issues.push(issue(`references.${input.index}.url`, "unsafe_reference_url", "Reference URLs must use http(s)."));
  }
  for (const key of ["path", "artifact_id", "tool_call_id", "task_id"] as const) {
    const text = key === "path" ? stringValue(input.record[key]) : safeReferenceText(input.record[key]);
    if (text) reference[key] = text;
    if (input.record[key] !== undefined && !text) {
      issues.push(issue(`references.${input.index}.${key}`, "unsafe_reference_text", "Reference text is not public-safe."));
    }
  }
  if (Object.keys(reference).length === 0) {
    issues.push(issue(`references.${input.index}`, "empty_reference", "Reference must include a safe locator."));
    return { reference: null, issues };
  }
  if (reference.path && !isSafeReferencePath(reference.path)) {
    issues.push(issue(`references.${input.index}.path`, "unsafe_reference_path", "Reference paths must not expose private absolute paths."));
    return { reference: null, issues };
  }
  return { reference, issues };
}

function receiptSupportsObligation(input: {
  capability: EvidenceCapabilityReceipt["capability"];
  evidenceKind: EvidenceCapabilityReceipt["evidence_kind"];
  references: EvidenceCapabilityReference[];
  obligation: PublicWorkObligationKind;
}): boolean {
  const supportedKind = OBLIGATION_POLICY[input.obligation].some((policy) =>
    policy.capability === input.capability && policy.evidenceKinds.includes(input.evidenceKind),
  );
  if (!supportedKind) return false;
  if (input.obligation === "source_verified" && input.evidenceKind === "source_page") {
    return input.references.some((reference) => Boolean(reference.url));
  }
  if (
    input.obligation === "durable_artifact" ||
    input.obligation === "data_table_created" ||
    input.obligation === "chart_rendered"
  ) {
    return input.references.some((reference) =>
      Boolean(reference.artifact_id || reference.path || reference.label),
    );
  }
  return true;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function safeReferenceText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  if (looksPrivateOrSecret(raw)) return null;
  const text = sanitizePublicText(raw, "").trim();
  if (!text || looksPrivateOrSecret(text)) return null;
  return text.slice(0, 240);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function looksPrivateOrSecret(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /(?:bearer|token|api[_-]?key|secret)\s*[:=]/iu.test(value)
    || /\b(?:authorization|bearer|\[redacted\])\b/iu.test(value)
  );
}

function isSafeReferencePath(path: string): boolean {
  return !looksPrivateOrSecret(path) && !path.split(/[\\/]+/u).includes("..");
}

function issue(field: string, code: string, message: string): EvidenceCapabilityReceiptIssue {
  return { field, code, message };
}
