import { sanitizePublicText } from "../events/turn-events.ts";
import { sourceUrlsFromWebSearchAudit } from "../policy/runtime-policy.ts";
import type {
  PublicWorkDecision,
  PublicWorkObligationKind,
  ToolAuditEntry,
} from "../turn/native-tool-types.ts";
import {
  type CompletionObligationEvidenceOutcome,
  readCompletionObligationEvidenceFromAudit,
} from "./completion-obligation-evidence.ts";

export interface CompletionObligationReview {
  required: PublicWorkObligationKind[];
  outcome: CompletionObligationEvidenceOutcome | "not_required";
  satisfied: PublicWorkObligationKind[];
  missingCritical: PublicWorkObligationKind[];
  missingNonCritical: PublicWorkObligationKind[];
  limitations: string[];
  incompleteReason: string | null;
}

export function reviewCompletionObligations(input: {
  audit: ToolAuditEntry[];
  decisions?: PublicWorkDecision[];
}): CompletionObligationReview {
  const required = requiredCompletionObligations(input.decisions ?? []);
  if (required.length === 0) {
    return {
      required,
      outcome: "not_required",
      satisfied: [],
      missingCritical: [],
      missingNonCritical: [],
      limitations: [],
      incompleteReason: null,
    };
  }
  const read = readCompletionObligationEvidenceFromAudit({
    audit: input.audit,
    required,
  });
  const incompleteReason = completionObligationEvidenceIncompleteReason({
    outcome: read.outcome,
    missingCritical: read.missingCritical,
  });
  return {
    required,
    outcome: read.outcome,
    satisfied: read.satisfied,
    missingCritical: read.missingCritical,
    missingNonCritical: read.missingNonCritical,
    limitations: read.limitations,
    incompleteReason,
  };
}

export function completionObligationIncompleteReason(input: {
  audit: ToolAuditEntry[];
  decisions?: PublicWorkDecision[];
}): string | null {
  return reviewCompletionObligations(input).incompleteReason;
}

export function unsatisfiedCompletionObligations(
  audit: ToolAuditEntry[],
  decisions: PublicWorkDecision[],
): PublicWorkObligationKind[] {
  const review = reviewCompletionObligations({
    audit,
    decisions,
  });
  return [...review.missingCritical, ...review.missingNonCritical];
}

export function requiredCompletionObligations(
  decisions: PublicWorkDecision[],
): PublicWorkObligationKind[] {
  const required = new Set<PublicWorkObligationKind>();
  for (const decision of decisions) {
    for (const obligation of decision.completionObligations ?? []) required.add(obligation);
  }
  return [...required];
}

export function finalResultEvidenceRepairInstructions(): string[] {
  return [
    "If the previous answer also claimed a durable deliverable that observed tool evidence has not produced and an available native tool can produce it, call the relevant tool first.",
    "Durable deliverables require durable evidence. Inline text or a code block is not enough when the user asked for a file, artifact, saved output, patch, or attachment. Tool evidence with an artifact id, artifact label, artifact path, written file, patch result, or attachment reference satisfies this requirement.",
    "Use the verified evidence and completed tool evidence below. If evidence is incomplete, state the missing part in result language instead of process-note language.",
  ];
}

export function goalCompletionEvidenceReviewInstructions(): string[] {
  return [
    "If a requested deliverable, verification step, durable artifact, or evidence-backed action is still missing and an available native tool can complete it, call the relevant tool now.",
    "Do not claim that the chat, text, or response environment prevents creating files, images, charts, or saved reports while an artifact-capable native tool can still advance that outcome.",
    "You may reuse public facts, values, URLs, labels, artifact references, and other non-secret evidence already extracted in the previous answer when that answer is backed by observed tool evidence.",
    "Discovery/search evidence identifies candidates; it is not the same as verification. If the original request requires source verification or an evidence-backed durable output and no read, inspect, or query step has verified a candidate, do not stop at the candidate list; call an available capability that performs that verification before finalizing.",
    "The evidence summary distinguishes search candidate URLs from read/verified source URLs. Search candidate URLs alone do not satisfy a direct source-check requirement.",
    "A single inconclusive or low-evidence search attempt is not enough to declare failure when the task asks for current/source-backed information and search or read capabilities remain available. Broaden, retry, or verify a candidate first.",
    "For local config, manifest, script, log, or code inspection, do not treat an empty result from one exact case-sensitive text search as proof of absence when the user used a human-facing term. If a local command tool remains available, use structured extraction or a case-insensitive search before finalizing an absence claim.",
    "Durable deliverables require durable evidence. If the original request asks for a file, artifact, saved output, patch, or attachment, inline text or a code block in the previous answer does not satisfy it unless observed tool evidence includes an artifact id, artifact label, artifact path, written file, patch result, or attachment reference.",
    "Generated charts, data files, and executable-code outcomes require execution or verification when an execution-capable tool is available. Do not satisfy those requests by only returning copy-paste code unless the user explicitly asked for code only.",
    "Review each recent public work decision's `completion_obligations`. If any accepted obligation remains unsatisfied by observed tool evidence, call an available tool that can satisfy it before final delivery.",
    "Completion obligations are protocol facts, not free-text hints: source_verified requires read/verified external source evidence or durable internal state inspection evidence, command_executed requires a successful command execution, durable_artifact/data_table_created/chart_rendered require matching artifact or execution evidence.",
    "Never return only `completion_obligations` as the answer. If an obligation is missing and a tool can satisfy it, call the tool; otherwise return `INCOMPLETE:` with a safe user-facing reason.",
    "If the request cannot be fully completed with available evidence or tools, return `INCOMPLETE: <safe user-facing reason>` and do not present the task as complete.",
    "Use `INCOMPLETE:` only when no available tool can advance the missing outcome. If any available tool can still advance the task, call that tool instead.",
  ];
}

export function renderCompletionEvidenceForReview(audit: ToolAuditEntry[], decisions: PublicWorkDecision[]): string {
  const lines = [
    "Completed public evidence summary:",
    ...audit
      .filter((entry) => entry.ok)
      .slice(-6)
      .map((entry, index) => `- ${index + 1}. ${finalEvidenceLine(entry)}`),
  ];
  const recentDecisions = decisions.slice(-4).map((decision) => finalDecisionLine(decision));
  if (recentDecisions.length > 0) {
    lines.push(
      "",
      "Recent public work decisions, including pending next steps:",
      ...recentDecisions.map((decision) => `- ${decision}`),
    );
  }
  const readSourceUrls = [
    ...sourceUrlsFromAuditByTool(audit, "web_read"),
  ].slice(0, 5);
  if (readSourceUrls.length > 0) {
    lines.push(
      "",
      "Read or verified source URLs:",
      ...readSourceUrls.map((url) => `- ${url}`),
    );
  }
  const searchCandidateUrls = sourceUrlsFromAuditByTool(audit, "web_search")
    .filter((url) => !readSourceUrls.includes(url))
    .slice(0, 5);
  if (searchCandidateUrls.length > 0) {
    lines.push(
      "",
      "Search candidate URLs (not verification by themselves):",
      ...searchCandidateUrls.map((url) => `- ${url}`),
    );
  }
  const review = reviewCompletionObligations({ audit, decisions });
  if (review.outcome !== "not_required") {
    lines.push(
      "",
      "Completion obligation review:",
      `- outcome: ${review.outcome}`,
      `- required: ${review.required.join(", ") || "none"}`,
      `- satisfied: ${review.satisfied.join(", ") || "none"}`,
      `- missing critical: ${review.missingCritical.join(", ") || "none"}`,
      `- missing non-critical: ${review.missingNonCritical.join(", ") || "none"}`,
    );
    if (review.limitations.length > 0) {
      lines.push(
        "- limitations:",
        ...review.limitations.slice(0, 4).map((limitation) => `  - ${safePublicEvidenceText(limitation)}`),
      );
    }
  }
  return lines.join("\n");
}

function completionObligationEvidenceIncompleteReason(input: {
  outcome: CompletionObligationEvidenceOutcome;
  missingCritical: PublicWorkObligationKind[];
}): string | null {
  if (input.outcome === "satisfied" || input.outcome === "limitation") return null;
  const missing = input.missingCritical.join(", ");
  if (input.outcome === "explicit_blocker") {
    return `The turn is blocked by unresolved public completion obligation(s): ${missing}.`;
  }
  return `The turn still needs repair for missing public completion obligation(s): ${missing}.`;
}

function finalDecisionLine(decision: PublicWorkDecision): string {
  const parts = [
    `summary: ${safePublicEvidenceText(decision.summary)}`,
    decision.rationale ? `why: ${safePublicEvidenceText(decision.rationale)}` : "",
    decision.nextStep ? `next: ${safePublicEvidenceText(decision.nextStep)}` : "",
    decision.completionObligations && decision.completionObligations.length > 0
      ? `completion_obligations: ${decision.completionObligations.join(", ")}`
      : "",
  ].filter(Boolean);
  return safePublicEvidenceText(parts.join(" | "));
}

function sourceUrlsFromAuditByTool(audit: ToolAuditEntry[], toolName: string): string[] {
  return sourceUrlsFromToolEvidence(audit.filter((entry) => entry.name === toolName));
}

function finalEvidenceLine(entry: ToolAuditEntry): string {
  const result = entry.result as Record<string, unknown> | undefined;
  const parts = [safePublicEvidenceText(entry.publicDecision?.summary ?? "") || "A native tool step succeeded"];
  const sourceUrls = sourceUrlsFromToolEvidence([entry]).slice(0, 3);
  if (sourceUrls.length > 0) parts.push(`sources: ${sourceUrls.join(", ")}`);
  const artifacts = safeArtifactReferences(result).slice(0, 3);
  if (artifacts.length > 0) parts.push(`artifacts: ${artifacts.join(", ")}`);
  const preview = safePreviewValue(result);
  if (preview) parts.push(`preview: ${preview}`);
  return parts.join("; ");
}

function safeArtifactReferences(result: Record<string, unknown> | undefined): string[] {
  if (!result) return [];
  const values = [
    result.artifact_label,
    result.artifact_id,
    result.attachment_ref,
    result.output_label,
    result.file_label,
    result.written_file,
    result.patch_result,
    result.artifact_labels,
    result.written_files,
    result.verified_output_files,
  ];
  return values
    .flatMap((value) => artifactReferenceValues(value))
    .map((value) => safePublicEvidenceText(value))
    .filter(Boolean);
}

function artifactReferenceValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => artifactReferenceValues(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return artifactReferenceValues(record.path ?? record.label ?? record.artifact_label);
  }
  return [];
}

function safePreviewValue(result: Record<string, unknown> | undefined): string {
  if (!result) return "";
  for (const [key, value] of Object.entries(result)) {
    if (!/preview$/iu.test(key) || typeof value !== "string") continue;
    const safe = safePublicEvidenceText(value);
    if (safe) return safe;
  }
  return "";
}

function sourceUrlsFromToolEvidence(audit: ToolAuditEntry[]): string[] {
  const urls = [...sourceUrlsFromWebSearchAudit(audit)];
  for (const entry of audit) {
    if (!entry.ok) continue;
    const result = entry.result && typeof entry.result === "object" && !Array.isArray(entry.result)
      ? entry.result as Record<string, unknown>
      : undefined;
    if (!result) continue;
    for (const value of [
      result.sourceUri,
      result.source_uri,
      result.source_url,
      result.final_url,
    ]) {
      if (typeof value === "string" && value.trim()) urls.push(value.trim());
    }
    for (const value of [
      result.sourceUrls,
      result.source_urls,
      result.citations,
    ]) {
      if (!Array.isArray(value)) continue;
      urls.push(...value.filter((url): url is string => typeof url === "string" && url.trim().length > 0));
    }
  }
  return [...new Set(urls)];
}

function safePublicEvidenceText(value: string): string {
  const sanitized = sanitizePublicText(value, "");
  if (!sanitized) return "";
  if (sanitized.length > 420) return sanitized.slice(0, 420);
  return sanitized;
}
