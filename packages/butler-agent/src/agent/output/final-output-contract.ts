import { sanitizePublicText } from "../events/turn-events.ts";
import type {
  PublicWorkDecision,
  PublicWorkObligationKind,
  ToolAuditEntry,
} from "../turn/native-tool-types.ts";
import { sourceUrlsFromWebSearchAudit } from "../policy/runtime-policy.ts";
import {
  evidenceReceiptsFromResult,
  satisfiedCompletionObligationsFromEvidenceReceipts,
} from "./evidence-receipts.ts";

export function finalResultContractRepairPrompt(input: {
  prompt: string;
  previousAnswer: string;
  audit: ToolAuditEntry[];
  decisions: PublicWorkDecision[];
}): string {
  return [
    "## Final Result Contract Repair",
    "The previous final answer exposed public work decision fields as the result.",
    "If it also claimed a durable deliverable that observed tool evidence has not produced and an available native tool can produce it, call the relevant tool first.",
    "Then rewrite the final answer as the user-facing outcome report only.",
    "Do not include `작업/이유/다음`, `Work/Why/Next`, raw tool ids, tool-call order, public_work_decision_context, or raw tool logs.",
    "Preserve the active persona, user language, and any current-turn Active Persona Reminder while rewriting.",
    "Durable deliverables require durable evidence. Inline text or a code block is not enough when the user asked for a file, artifact, saved output, patch, or attachment. Tool evidence with an artifact id, artifact label, artifact path, written file, patch result, or attachment reference satisfies this requirement.",
    "Use the verified evidence and completed tool evidence below. If evidence is incomplete, state the missing part in result language instead of process-note language.",
    "",
    "Original request:",
    input.prompt,
    "",
    renderFinalEvidenceForRepair(input.audit, input.decisions),
    "",
    "Previous invalid final answer:",
    input.previousAnswer.trim(),
  ].join("\n");
}

export function goalCompletionReviewPrompt(input: {
  prompt: string;
  previousAnswer: string;
  audit: ToolAuditEntry[];
  decisions: PublicWorkDecision[];
}): string {
  return [
    "## Goal Completion Review",
    "Review the previous answer against the user's original request and the observed native tool evidence.",
    "This is a generic completion review for every native tool. Do not apply hardcoded rules for any specific tool.",
    "This review is an action gate, not an explanation gate: if the task can still be advanced with an available tool, call the tool instead of returning an incomplete final answer.",
    "If the previous answer is only a work decision, process note, or `작업/이유/다음` block, it is not a final answer. Continue by calling an appropriate available tool when the tool catalog can advance the request.",
    "If the previous answer fully satisfies the user's requested outcome, return the final user-facing answer only.",
    "Preserve the active persona, user language, and any current-turn Active Persona Reminder in that final user-facing answer.",
    "If a requested deliverable, verification step, durable artifact, or evidence-backed action is still missing and an available native tool can complete it, call the relevant tool now.",
    "Attached native tool schemas are the source of truth for available capabilities and required inputs. Do not claim that a tool or input format is unavailable before comparing the missing outcome with those schemas.",
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
    "Do not ask the user to rerun or send the same request again. Continue autonomously unless the task is impossible to continue without a principal decision.",
    "Do not include raw tool ids, tool-call order, public_work_decision_context, or raw tool logs in the final answer.",
    "",
    "Original request:",
    input.prompt,
    "",
    renderFinalEvidenceForRepair(input.audit, input.decisions),
    "",
    "Previous answer to review:",
    input.previousAnswer.trim(),
  ].join("\n");
}

export function goalCompletionIncompleteContinuationPrompt(input: {
  prompt: string;
  previousAnswer: string;
  incompleteReason: string;
  audit: ToolAuditEntry[];
  decisions: PublicWorkDecision[];
}): string {
  return [
    "## Goal Completion Incomplete Continuation",
    "The previous completion review returned `INCOMPLETE`, so the turn is not deliverable yet.",
    "Do not treat that as a final answer. Continue the original user request now.",
    "If an available native tool can advance the missing requested outcome, call that tool.",
    "If the missing outcome can be completed by inspecting local files, running checks, editing files, committing, or reading durable state, use the relevant native tool instead of stopping.",
    "Return `INCOMPLETE: <safe user-facing reason>` only when no available tool can advance the missing outcome or a principal decision is required.",
    "Preserve the active persona, user language, and any current-turn Active Persona Reminder.",
    "",
    "Incomplete reason:",
    input.incompleteReason,
    "",
    "Original request:",
    input.prompt,
    "",
    renderFinalEvidenceForRepair(input.audit, input.decisions),
    "",
    "Previous incomplete answer:",
    input.previousAnswer.trim(),
  ].join("\n");
}

function renderFinalEvidenceForRepair(audit: ToolAuditEntry[], decisions: PublicWorkDecision[]): string {
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
  return lines.join("\n");
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

function safePublicEvidenceText(value: string): string {
  // Final repairs can quote tool evidence back to the model, so keep evidence public-safe here too.
  const sanitized = sanitizePublicText(value, "");
  if (!sanitized) return "";
  if (sanitized.length > 420) return sanitized.slice(0, 420);
  return sanitized;
}

export function containsFinalPublicWorkDecisionLeak(value: string): boolean {
  const sample = value.trimStart().slice(0, 1_200);
  const hasWork = /(?:^|\n)\s*(?:[-*]|\d+[.)])?\s*(?:작업|work)\s*[:：-]\s*\S/iu.test(sample);
  const hasWhy = /(?:^|\n)\s*(?:[-*]|\d+[.)])?\s*(?:이유|근거|why|rationale)\s*[:：-]\s*\S/iu.test(sample);
  const hasNext = /(?:^|\n)\s*(?:[-*]|\d+[.)])?\s*(?:다음|다음 단계|next)\s*[:：-]\s*\S/iu.test(sample);
  const startsWithWork = /^\s*(?:[-*]|\d+[.)])?\s*(?:작업|work)\s*[:：-]\s*\S/iu.test(sample);
  return hasWork && hasWhy && (hasNext || startsWithWork);
}

export function containsFinalToolImplementationLeak(value: string, toolNames: string[]): boolean {
  const sample = value.slice(0, 2_500);
  if (
    /FileNotFoundException|stack trace|tool_call|raw tool|raw payload|public_work_decision|completion_obligations|previous turn|the system|\b(?:task|worker|planned)-[A-Za-z0-9][A-Za-z0-9._-]{1,}\b/iu.test(sample) ||
    containsFinalReviewProtocolLeak(sample)
  ) {
    return true;
  }
  return sample.split(/\r?\n/u).some((line) => containsToolExecutionLeakLine(line, toolNames));
}

export function completionReviewIncompleteReason(value: string): string | null {
  const match = value.trim().match(/^(?:INCOMPLETE|미완료)\s*[:：]\s*(.+)$/isu);
  const reason = match?.[1]?.trim();
  if (!reason) return null;
  const sanitized = sanitizePublicText(reason, "Butler could not complete this turn.");
  return sanitized || "Butler could not complete this turn.";
}

export function completionObligationIncompleteReason(input: {
  audit: ToolAuditEntry[];
  decisions?: PublicWorkDecision[];
}): string | null {
  const missing = unsatisfiedCompletionObligations(input.audit, input.decisions ?? []);
  if (missing.length === 0) return null;
  return `The turn still has unsatisfied public completion obligation(s): ${missing.join(", ")}.`;
}

export function unsatisfiedCompletionObligations(
  audit: ToolAuditEntry[],
  decisions: PublicWorkDecision[],
): PublicWorkObligationKind[] {
  const required = new Set<PublicWorkObligationKind>();
  for (const decision of decisions) {
    for (const obligation of effectiveCompletionObligations(decision)) required.add(obligation);
  }
  if (required.size === 0) return [];
  const satisfied = satisfiedCompletionObligations(audit);
  return Array.from(required).filter((obligation) => !satisfied.has(obligation));
}

function effectiveCompletionObligations(decision: PublicWorkDecision): PublicWorkObligationKind[] {
  const obligations = decision.completionObligations ?? [];
  if (!obligations.includes("durable_artifact")) return obligations;
  if (!isInspectionOnlyDurableArtifactDecision(decision)) return obligations;
  return obligations.filter((obligation) => obligation !== "durable_artifact");
}

function isInspectionOnlyDurableArtifactDecision(decision: PublicWorkDecision): boolean {
  const actionText = [
    decision.summary ?? "",
    decision.nextStep ?? "",
  ].join("\n");
  const fullText = [
    actionText,
    decision.rationale ?? "",
  ].join("\n");
  if (
    !/(?:verify|verification|check|checking|confirm|read|review|inspect|list|find|grep|exists|existence|presence|absence|query|status|확인|검증|조회|읽|목록|찾|존재|부재|상태|본문|경로)/iu.test(fullText)
  ) {
    return false;
  }
  return !hasActiveDurableArtifactCreation(actionText);
}

function hasActiveDurableArtifactCreation(text: string): boolean {
  if (/\b(?:create|write|generate|render|attach|save|patch|update|edit|produce)\b/iu.test(text)) {
    return true;
  }
  return /(?:작성|생성|렌더|저장|첨부|수정|갱신|패치|만들).{0,16}(?:합니다|하겠다|해야|한 뒤|하고|해서|한다|할 것|할게)/iu.test(text);
}

function satisfiedCompletionObligations(audit: ToolAuditEntry[]): Set<PublicWorkObligationKind> {
  const satisfied = new Set<PublicWorkObligationKind>();
  for (const entry of audit) {
    if (!entry.ok) continue;
    for (const obligation of satisfiedCompletionObligationsFromEvidenceReceipts([
      ...(entry.evidenceReceipts ?? []),
      ...evidenceReceiptsFromResult(entry.result),
    ])) {
      satisfied.add(obligation);
    }
    for (const obligation of entry.satisfiedCompletionObligations ?? []) {
      satisfied.add(obligation);
    }
    const result = entry.result && typeof entry.result === "object" && !Array.isArray(entry.result)
      ? entry.result as Record<string, unknown>
      : undefined;
    if (hasVerifiedSourceEvidence(entry, result)) {
      satisfied.add("source_verified");
    }
    if (entry.name === "run_command" && commandSucceeded(result)) {
      satisfied.add("command_executed");
      if (commandRenderedChart(result)) satisfied.add("chart_rendered");
    }
    if (entry.name === "transform_public_data_table" || commandCreatedDataTable(result)) {
      satisfied.add("data_table_created");
    }
    if (hasDurableArtifactEvidence(result)) {
      satisfied.add("durable_artifact");
      if (result?.artifact_kind === "csv_file") satisfied.add("data_table_created");
    }
  }
  return satisfied;
}

function durableStateInspectionCompleted(toolName: string): boolean {
  if (
    toolName !== "get_work_dashboard" &&
    toolName !== "inspect_project_status" &&
    toolName !== "query_project_work" &&
    toolName !== "list_tasks" &&
    toolName !== "get_task_result" &&
    toolName !== "list_work_streams"
  ) {
    return false;
  }
  return true;
}

function hasVerifiedSourceEvidence(entry: ToolAuditEntry, _result: Record<string, unknown> | undefined): boolean {
  if (entry.name === "web_read") return sourceUrlsFromToolEvidence([entry]).length > 0;
  if (durableStateInspectionCompleted(entry.name)) return true;
  return false;
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

function commandSucceeded(result: Record<string, unknown> | undefined): boolean {
  if (!result) return true;
  if (result.ok === false) return false;
  if (result.timed_out === true) return false;
  return result.exit_code === undefined || result.exit_code === 0;
}

function hasDurableArtifactEvidence(result: Record<string, unknown> | undefined): boolean {
  return Boolean(result?.durable_artifact_created) || safeArtifactReferences(result).length > 0;
}

function commandCreatedDataTable(result: Record<string, unknown> | undefined): boolean {
  if (!result) return false;
  if (result.data_table_created === true) return true;
  return artifactKinds(result).some((kind) => kind === "csv_file" || kind === "table_file");
}

function commandRenderedChart(result: Record<string, unknown> | undefined): boolean {
  if (!result) return false;
  if (result.chart_rendered === true) return true;
  return artifactKinds(result).includes("chart_file");
}

function artifactKinds(result: Record<string, unknown>): string[] {
  const values = [result.artifact_kind, result.artifact_kinds];
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function stripLeadingPublicWorkDecisionBlock(value: string): string {
  const lines = value.split(/\r?\n/u);
  let index = 0;
  let sawField = false;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      index += 1;
      if (sawField) continue;
      continue;
    }
    if (/^(?:[-*]|\d+[.)])?\s*(?:작업|work|이유|근거|why|rationale|다음|다음 단계|next)\s*[:：-]/iu.test(line)) {
      sawField = true;
      index += 1;
      continue;
    }
    break;
  }
  const stripped = lines.slice(index).join("\n").trim();
  return stripped;
}

export function stripToolImplementationLeakLines(value: string, toolNames: string[]): string {
  const explicitFinal = finalAnswerSegmentFromProtocolLeak(value);
  if (explicitFinal) return explicitFinal;
  const leaked = [
    "FileNotFoundException",
    "stack trace",
    "tool_call",
    "raw tool",
    "raw payload",
    "public_work_decision",
    "completion_obligations",
    "previous turn",
    "the system",
    "Goal Completion Review",
    "Final Result Contract Repair",
    "previous answer",
    "Previous answer",
    "review concludes",
    "I will return",
    "Preserve persona",
  ].filter(Boolean);
  const lines = value.split(/\r?\n/u)
    .filter((line) =>
      !leaked.some((marker) => line.includes(marker)) &&
      !containsToolExecutionLeakLine(line, toolNames) &&
      !/\b(?:task|worker|planned)-[A-Za-z0-9][A-Za-z0-9._-]{1,}\b/iu.test(line),
    );
  const stripped = lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return stripped;
}

function containsToolExecutionLeakLine(line: string, toolNames: string[]): boolean {
  if (!toolNames.some((name) => name && line.includes(name))) return false;
  return /\b(?:called|calling|call|used|using|ran|run|executed|executing|invoke|invoked|created artifact|tool output|tool result)\b|(?:도구\s*(?:호출|실행|사용|결과|출력|로그)|호출한\s*도구|실행한\s*도구|사용한\s*도구)/iu.test(line);
}

function containsFinalReviewProtocolLeak(value: string): boolean {
  return /Goal Completion Review|Final Result Contract Repair|previous answer|Previous answer|review concludes|I will return only the final user-facing answer|Preserve persona|as instructed by|One detail check/iu
    .test(value);
}

function finalAnswerSegmentFromProtocolLeak(value: string): string {
  if (!containsFinalReviewProtocolLeak(value)) return "";
  const masked = value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, (block) =>
    " ".repeat(block.length),
  );
  const marker = /(?:^|\n)\s*(?:\*\*)?Final Answer(?:\*\*)?\s*[:：]\s*/giu;
  let latestEnd: number | null = null;
  for (const match of masked.matchAll(marker)) {
    if (match.index === undefined) continue;
    latestEnd = match.index + match[0].length;
  }
  if (latestEnd === null) return "";
  const segment = value.slice(latestEnd).replace(/\n{3,}/gu, "\n\n").trim();
  return sanitizePublicText(segment, "").trim();
}
