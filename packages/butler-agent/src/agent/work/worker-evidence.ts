import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";

export type WorkerTaskClassification =
  | "implementation-required"
  | "research-only"
  | "review-only"
  | "writing-only"
  | "diagnosis-only"
  | "explicit-blocker";

export interface WorkerCompletionEvidenceSummary {
  classification: WorkerTaskClassification;
  implementation_required: boolean;
  has_file_created: boolean;
  has_file_modified: boolean;
  has_patch_applied: boolean;
  has_diff_generated: boolean;
  has_test_added_or_updated: boolean;
  has_commit_created: boolean;
  has_blocker: boolean;
  has_intermediate_blocker: boolean;
  has_final_blocker: boolean;
  has_environment_blocker: boolean;
  has_execution_evidence: boolean;
  has_verification_evidence: boolean;
  has_report_evidence: boolean;
  evidence_refs: string[];
  safe_to_report: boolean;
  completion_claim_allowed: boolean;
  guard_reason: string | null;
}

type WorkerActivityEvent = {
  event?: unknown;
  semantic_phase?: unknown;
  action_kind?: unknown;
  status_line?: unknown;
  decision_summary?: unknown;
  completion_review?: unknown;
  completion_contract?: unknown;
  evidence_refs?: unknown;
};

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readJsonl<T>(path: string): T[] {
  const text = readText(path).trim();
  if (!text) return [];
  const rows: T[] = [];
  for (const line of text.split(/\r?\n/u)) {
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Ignore corrupt observability rows; a bad row must not become evidence.
    }
  }
  return rows;
}

function compact(value: string, limit = 160): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function classifyTaskText(text: string): WorkerTaskClassification {
  const value = text.toLocaleLowerCase("en-US");
  if (/(blocked|blocker|cannot safely|can't safely|불가능|막힘|차단|진행할 수 없)/iu.test(value)) {
    return "explicit-blocker";
  }
  if (/(implement|fix|change|modify|patch|edit|create|add|update|refactor|ship|수정|구현|변경|추가|고쳐|만들|반영)/iu.test(value)) {
    return "implementation-required";
  }
  if (/(review|audit|검토|리뷰)/iu.test(value)) return "review-only";
  if (/(research|investigate|diagnose|analy[sz]e|summari[sz]e|check|verify|inspect|조사|분석|진단|파악|요약|확인|검증)/iu.test(value)) return "diagnosis-only";
  if (/(write|draft|document|문서|작성|정리)/iu.test(value)) return "writing-only";
  return "implementation-required";
}

function classificationForTask(taskDir: string): WorkerTaskClassification {
  const explicit = readText(join(taskDir, "classification")).trim();
  if (
    explicit === "implementation-required" ||
    explicit === "research-only" ||
    explicit === "review-only" ||
    explicit === "writing-only" ||
    explicit === "diagnosis-only" ||
    explicit === "explicit-blocker"
  ) {
    return explicit;
  }
  const request = readText(join(taskDir, "request.md"));
  const plan = readText(join(taskDir, "plan.md"));
  if (!request.trim() && !plan.trim()) return "diagnosis-only";
  return classifyTaskText(`${request}\n${plan}`);
}

function hasRecentFile(taskDir: string, relativePath: string): boolean {
  const path = join(taskDir, relativePath);
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function evidenceFromActivity(taskDir: string): Partial<WorkerCompletionEvidenceSummary> {
  const events = readJsonl<WorkerActivityEvent>(join(taskDir, "worker_activity_events.jsonl"));
  const refs: string[] = [];
  let hasExecution = false;
  let hasVerification = false;
  let hasReport = false;
  let hasBlocker = false;
  let hasPatch = false;
  let hasDiff = false;
  let hasTest = false;
  let hasCommit = false;
  let hasFileModified = false;
  let hasFileCreated = false;
  let hasIntermediateBlocker = false;
  let hasFinalBlocker = false;
  let hasEnvironmentBlocker = false;

  for (const event of events) {
    if (Array.isArray(event.evidence_refs)) {
      refs.push(...event.evidence_refs.filter((ref): ref is string => typeof ref === "string"));
    }
    const semantic = typeof event.semantic_phase === "string" ? event.semantic_phase : "";
    const action = typeof event.action_kind === "string" ? event.action_kind : "";
    const text = [
      typeof event.status_line === "string" ? event.status_line : "",
      typeof event.decision_summary === "string" ? event.decision_summary : "",
    ].join(" ").toLocaleLowerCase("en-US");
    const contract = event.completion_contract && typeof event.completion_contract === "object"
      ? event.completion_contract as Record<string, unknown>
      : {};

    if (semantic === "executing") hasExecution = true;
    if (semantic === "verifying") hasVerification = true;
    if (semantic === "reporting") hasReport = true;
    const blockedLike =
      semantic === "blocked" ||
      event.completion_review === "blocked" ||
      contract.has_blocker_evidence === true;
    const terminalBlocker =
      blockedLike &&
      (
        event.event === "worker_failed" ||
        event.event === "worker_finished" ||
        event.completion_review === "blocked"
      );
    const environmentBlocker = blockedLike && isEnvironmentBlockerText(text);
    if (blockedLike) hasBlocker = true;
    if (terminalBlocker) hasFinalBlocker = true;
    else if (blockedLike) hasIntermediateBlocker = true;
    if (environmentBlocker && terminalBlocker) hasEnvironmentBlocker = true;
    else if (environmentBlocker) hasIntermediateBlocker = true;
    if (contract.has_execution_evidence === true) hasExecution = true;
    if (contract.has_verification_evidence === true) hasVerification = true;
    if (contract.has_commit_evidence === true) hasCommit = true;

    if (/(apply_patch|patch)/iu.test(action) || /\bpatch\b/iu.test(text)) hasPatch = true;
    if (/(edit_file|write_file|file_modified|modify)/iu.test(action) || /(modified|updated|edited|wrote|created)/iu.test(text)) hasFileModified = true;
    if (/(create_file|file_created)/iu.test(action) || /(created|added)/iu.test(text)) hasFileCreated = true;
    if (/(test|typecheck|lint|verify|검증)/iu.test(action) || /(test|typecheck|lint|검증|verified)/iu.test(text)) hasTest = true;
    if (/(git_diff|diff)/iu.test(action) || /\bgit diff\b|\bdiff\b/iu.test(text)) hasDiff = true;
    if (/(commit)/iu.test(action) || /\bgit commit\b|\bcommitted\b/iu.test(text)) hasCommit = true;
  }

  return {
    has_execution_evidence: hasExecution,
    has_verification_evidence: hasVerification,
    has_report_evidence: hasReport,
    has_blocker: hasBlocker,
    has_patch_applied: hasPatch,
    has_diff_generated: hasDiff,
    has_test_added_or_updated: hasTest,
    has_commit_created: hasCommit,
    has_file_modified: hasFileModified,
    has_file_created: hasFileCreated,
    has_intermediate_blocker: hasIntermediateBlocker,
    has_final_blocker: hasFinalBlocker,
    has_environment_blocker: hasEnvironmentBlocker,
    evidence_refs: refs,
  };
}

function evidenceFromLog(taskDir: string): Partial<WorkerCompletionEvidenceSummary> {
  const log = readText(join(taskDir, "log.txt"));
  const result = readText(join(taskDir, "result.md"));
  const text = `${log}\n${result}`;
  const resultHasBlocker = /\b(blocked|blocker|cannot safely|unable to proceed|TIMEOUT|deadlock|auth|credential)\b/iu.test(result);
  const resultEnvironmentBlocker = isEnvironmentBlockerText(result);
  const intermediateEnvironmentBlocker = !resultEnvironmentBlocker && isEnvironmentBlockerText(log);
  const commandLines = text
    .split(/\r?\n/u)
    .filter((line) => /run_shell|run_command|===== COMMAND:/u.test(line))
    .map((line) => compact(line, 220));
  return {
    has_patch_applied: /\b(apply_patch|patch\s+-p|git apply)\b/iu.test(text),
    has_diff_generated: /\bgit\s+diff\b|\bdiff\s+-/iu.test(text),
    has_test_added_or_updated: /\b(bun test|npm test|pnpm test|yarn test|vitest|jest|playwright|typecheck|lint|tsc)\b/iu.test(text),
    has_commit_created: /\bgit\s+commit\b|^\[[a-f0-9]{7,40}\]/imu.test(text),
    has_file_modified: /\b(sed\s+-i|perl\s+-pi|apply_patch|cat\s+>|printf\s+.*>|tee\s+|mv\s+.*|cp\s+.*)\b/iu.test(text),
    has_file_created: /\b(touch|mkdir\s+-p|cat\s+>|printf\s+.*>|tee\s+)\b/iu.test(text),
    has_execution_evidence: /run_shell|run_command|===== COMMAND:/u.test(text),
    has_verification_evidence: /\b(bun test|bun run check|npm test|pnpm test|yarn test|vitest|jest|playwright|typecheck|lint|tsc)\b/iu.test(text),
    has_blocker: resultHasBlocker || resultEnvironmentBlocker || intermediateEnvironmentBlocker,
    has_intermediate_blocker: (!resultHasBlocker && /\b(blocked|blocker|cannot safely|unable to proceed)\b/iu.test(log)) ||
      intermediateEnvironmentBlocker,
    has_final_blocker: resultHasBlocker,
    has_environment_blocker: resultEnvironmentBlocker,
    evidence_refs: commandLines.slice(-8),
  };
}

function evidenceFromReceipts(taskDir: string): Partial<WorkerCompletionEvidenceSummary> {
  const refs: string[] = [];
  let hasFileCreated = false;
  let hasFileModified = false;
  let hasPatch = false;
  let hasDiff = false;
  let hasTest = false;
  let hasCommit = false;
  let hasExecution = false;
  let hasVerification = false;
  const candidates = ["evidence-receipts.jsonl", "evidence_receipts.jsonl", "worker_evidence.jsonl"];
  for (const candidate of candidates) {
    for (const receipt of readJsonl<Record<string, unknown>>(join(taskDir, candidate))) {
      refs.push(`${candidate}:${compact(JSON.stringify(receipt), 120)}`);
      const satisfies = Array.isArray(receipt.satisfies)
        ? receipt.satisfies.filter((item): item is string => typeof item === "string")
        : [];
      const kind = typeof receipt.receiptType === "string" ? receipt.receiptType : "";
      if (kind === "execution" || satisfies.includes("command_executed")) hasExecution = true;
      if (satisfies.some((item) => /file_created/u.test(item))) hasFileCreated = true;
      if (satisfies.some((item) => /file_modified|durable_artifact/u.test(item))) hasFileModified = true;
      if (satisfies.some((item) => /patch/u.test(item))) hasPatch = true;
      if (satisfies.some((item) => /diff/u.test(item))) hasDiff = true;
      if (satisfies.some((item) => /test|validation|typecheck|lint/u.test(item))) hasTest = true;
      if (satisfies.some((item) => /commit/u.test(item))) hasCommit = true;
      if (kind === "verification" || hasTest) hasVerification = true;
    }
  }
  return {
    has_file_created: hasFileCreated,
    has_file_modified: hasFileModified,
    has_patch_applied: hasPatch,
    has_diff_generated: hasDiff,
    has_test_added_or_updated: hasTest,
    has_commit_created: hasCommit,
    has_execution_evidence: hasExecution,
    has_verification_evidence: hasVerification,
    evidence_refs: refs,
  };
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function evidenceFromWorkerTranscript(taskDir: string): Partial<WorkerCompletionEvidenceSummary> {
  const sessionId = readText(join(taskDir, "session_id")).trim();
  if (!sessionId) return {};
  const butlerData = dirname(dirname(taskDir));
  const transcriptPath = join(butlerData, "transcripts", `${sanitizeSessionId(`worker/${sessionId}`)}.jsonl`);
  const events = readJsonl<Record<string, unknown>>(transcriptPath);
  const refs: string[] = [];
  let hasExecution = false;
  let hasVerification = false;
  let hasFileCreated = false;
  let hasFileModified = false;
  let hasPatch = false;
  let hasDiff = false;
  let hasTest = false;
  let hasCommit = false;
  let hasBlocker = false;
  let hasIntermediateBlocker = false;
  const hasFinalBlocker = false;

  for (const event of events) {
    if (event.kind !== "tool_result" && event.kind !== "tool_call") continue;
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    const name = typeof payload.name === "string" ? payload.name : "";
    const result = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : {};
    const args = payload.arguments && typeof payload.arguments === "object" ? payload.arguments as Record<string, unknown> : {};
    const command = typeof result.command === "string"
      ? result.command
      : typeof args.command === "string"
        ? args.command
        : "";
    const text = `${name}\n${command}\n${JSON.stringify(result)}`;
    if (name === "run_command") hasExecution = true;
    if (Array.isArray(result.written_files) && result.written_files.length > 0) hasFileModified = true;
    if (Array.isArray(result.verified_output_files) && result.verified_output_files.length > 0) hasFileCreated = true;
    if (result.durable_artifact_created === true) hasFileCreated = true;
    if (/\b(apply_patch|patch\s+-p|git apply)\b/iu.test(text)) hasPatch = true;
    if (/\bgit\s+diff\b|\bdiff\s+-/iu.test(text)) hasDiff = true;
    if (/\b(bun test|npm test|pnpm test|yarn test|vitest|jest|playwright|typecheck|lint|tsc)\b/iu.test(text)) {
      hasTest = true;
      hasVerification = true;
    }
    if (/\bgit\s+commit\b|committed/iu.test(text)) hasCommit = true;
    if (/\b(blocked|blocker|cannot safely|unable to proceed)\b/iu.test(text)) {
      hasBlocker = true;
      hasIntermediateBlocker = true;
    }
    if (isEnvironmentBlockerText(text)) {
      hasBlocker = true;
      hasIntermediateBlocker = true;
    }
    if (event.kind === "tool_result") refs.push(`transcript:${compact(name || "tool", 40)}:${compact(command || JSON.stringify(result), 180)}`);
  }

  return {
    has_execution_evidence: hasExecution,
    has_verification_evidence: hasVerification,
    has_file_created: hasFileCreated,
    has_file_modified: hasFileModified,
    has_patch_applied: hasPatch,
    has_diff_generated: hasDiff,
    has_test_added_or_updated: hasTest,
    has_commit_created: hasCommit,
    has_blocker: hasBlocker,
    has_intermediate_blocker: hasIntermediateBlocker,
    has_final_blocker: hasFinalBlocker,
    has_environment_blocker: false,
    evidence_refs: refs,
  };
}

function isEnvironmentBlockerText(value: string): boolean {
  return /\b(?:tsc|typescript|bun|npm|pnpm|yarn|node_modules|dependency|dependencies)\b[\s\S]{0,120}\b(?:command not found|not found|missing|not installed)\b/iu.test(value) ||
    /\b(?:command not found|not found|missing|not installed)\b[\s\S]{0,120}\b(?:tsc|typescript|bun|npm|pnpm|yarn|node_modules|dependency|dependencies)\b/iu.test(value);
}

function mergeEvidence(
  classification: WorkerTaskClassification,
  parts: Array<Partial<WorkerCompletionEvidenceSummary>>,
): WorkerCompletionEvidenceSummary {
  const merged = {
    classification,
    implementation_required: classification === "implementation-required",
    has_file_created: false,
    has_file_modified: false,
    has_patch_applied: false,
    has_diff_generated: false,
    has_test_added_or_updated: false,
    has_commit_created: false,
    has_blocker: classification === "explicit-blocker",
    has_intermediate_blocker: false,
    has_final_blocker: classification === "explicit-blocker",
    has_environment_blocker: false,
    has_execution_evidence: false,
    has_verification_evidence: false,
    has_report_evidence: false,
    evidence_refs: [] as string[],
    safe_to_report: false,
    completion_claim_allowed: false,
    guard_reason: null as string | null,
  };
  for (const part of parts) {
    for (const key of [
      "has_file_created",
      "has_file_modified",
      "has_patch_applied",
      "has_diff_generated",
      "has_test_added_or_updated",
      "has_commit_created",
      "has_blocker",
      "has_intermediate_blocker",
      "has_final_blocker",
      "has_environment_blocker",
      "has_execution_evidence",
      "has_verification_evidence",
      "has_report_evidence",
    ] as const) {
      merged[key] = merged[key] || part[key] === true;
    }
    merged.evidence_refs.push(...(part.evidence_refs ?? []));
  }
  merged.evidence_refs = [...new Set(merged.evidence_refs.map((ref) => compact(ref, 240)).filter(Boolean))].slice(-20);

  const hasImplementationEvidence =
    merged.has_file_created ||
    merged.has_file_modified ||
    merged.has_patch_applied ||
    merged.has_diff_generated ||
    merged.has_test_added_or_updated ||
    merged.has_commit_created;

  merged.has_blocker = merged.has_final_blocker || merged.has_environment_blocker;

  if (merged.has_environment_blocker) {
    merged.safe_to_report = true;
    merged.completion_claim_allowed = false;
    merged.guard_reason = "Worker recorded an environment blocker; resolve dependencies or setup before claiming completion.";
    return merged;
  }

  if (merged.has_final_blocker) {
    merged.safe_to_report = true;
    merged.completion_claim_allowed = false;
    merged.guard_reason = "Worker recorded a final blocker; report the blocker, not completion.";
    return merged;
  }

  if (merged.implementation_required && !hasImplementationEvidence) {
    merged.safe_to_report = false;
    merged.completion_claim_allowed = false;
    merged.guard_reason = "Implementation-required worker task has no implementation evidence.";
    return merged;
  }

  if (!merged.implementation_required && !merged.has_execution_evidence && !merged.has_report_evidence && merged.evidence_refs.length === 0) {
    merged.safe_to_report = false;
    merged.completion_claim_allowed = false;
    merged.guard_reason = "Worker task has no durable evidence to review.";
    return merged;
  }

  merged.safe_to_report = true;
  merged.completion_claim_allowed = true;
  merged.guard_reason = null;
  return merged;
}

export function summarizeWorkerCompletionEvidence(taskDir: string): WorkerCompletionEvidenceSummary {
  const classification = classificationForTask(taskDir);
  const metadataRefs: string[] = [];
  if (hasRecentFile(taskDir, "result.md")) metadataRefs.push("result.md");
  if (existsSync(join(taskDir, "worker_activity_events.jsonl"))) metadataRefs.push("worker_activity_events.jsonl");
  if (existsSync(join(taskDir, "worker_activity.json"))) metadataRefs.push("worker_activity.json");
  if (existsSync(join(taskDir, "worker-preflight.md"))) metadataRefs.push("worker-preflight.md");
  try {
    const entries = readdirSync(taskDir);
    for (const entry of entries) {
      if (/^(patch|diff|commit|evidence)/iu.test(entry)) metadataRefs.push(entry);
    }
  } catch {
    // Missing task directories are handled as no-evidence summaries.
  }
  return mergeEvidence(classification, [
    evidenceFromActivity(taskDir),
    evidenceFromWorkerTranscript(taskDir),
    evidenceFromLog(taskDir),
    evidenceFromReceipts(taskDir),
    { evidence_refs: metadataRefs },
  ]);
}
