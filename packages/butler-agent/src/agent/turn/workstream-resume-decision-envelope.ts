import type {
  WorkStreamResumeCandidate,
  WorkStreamResumeCheckpoint,
  WorkStreamResumeSelection,
} from "./workstream-checkpoint-resume-types.ts";
import { checkpointNeedsWorkspaceProfile } from "./workstream-resume-tool-policy.ts";
import type { ButlerToolProfile } from "../tools/profiles.ts";

export interface WorkStreamResumeDecisionEnvelope {
  prompt: string;
  requiredNativeTools: string[];
  requiredNativeToolProfiles: ButlerToolProfile[];
  candidates: WorkStreamResumeCandidate[];
}

const MAX_DECISION_CANDIDATES = 3;
const MAX_ITEMS_PER_CANDIDATE = 5;
const MAX_REFS_PER_CANDIDATE = 6;

export function buildWorkStreamResumeDecisionEnvelope(input: {
  selection: WorkStreamResumeSelection;
  currentUserText: string;
}): WorkStreamResumeDecisionEnvelope | null {
  if (input.selection.state !== "resume_candidate_presented") return null;
  const candidates = input.selection.candidates.slice(0, MAX_DECISION_CANDIDATES);
  if (candidates.length === 0) return null;
  return {
    prompt: renderDecisionEnvelope({
      candidates,
      currentUserText: input.currentUserText,
    }),
    requiredNativeTools: requiredToolsForCandidates(candidates),
    requiredNativeToolProfiles: requiredProfilesForCandidates(candidates),
    candidates,
  };
}

export function turnMetadataWithResumeDecisionPolicy(
  metadata: Record<string, unknown> | undefined,
  envelope: WorkStreamResumeDecisionEnvelope | null,
): Record<string, unknown> | undefined {
  if (!envelope) return metadata;
  const trackingMode = envelope.candidates.some((candidate) => candidate.checkpoint.trackingMode === "ledger")
    ? "ledger"
    : "local";
  const closeoutStrategy = trackingMode === "ledger" ? "ledger" : "local_workstream";
  return {
    ...(metadata ?? {}),
    trackingMode,
    tracking_mode: trackingMode,
    closeoutStrategy,
    closeout_strategy: closeoutStrategy,
    runtimePolicy: {
      ...objectRecord(metadata?.runtimePolicy),
      trackingMode,
      tracking_mode: trackingMode,
      closeoutStrategy,
      closeout_strategy: closeoutStrategy,
    },
    requiredNativeTools: mergeStringArrays(
      stringArray(metadata?.requiredNativeTools),
      stringArray(metadata?.required_tools),
      envelope.requiredNativeTools,
    ),
    requiredNativeToolProfiles: mergeStringArrays(
      stringArray(metadata?.requiredNativeToolProfiles),
      stringArray(metadata?.required_tool_profiles),
      envelope.requiredNativeToolProfiles,
    ),
    workStreamResumeDecision: {
      candidateCount: envelope.candidates.length,
      candidateIds: envelope.candidates.map((candidate) => candidate.id),
      trackingMode,
      closeoutStrategy,
    },
  };
}

function renderDecisionEnvelope(input: {
  candidates: WorkStreamResumeCandidate[];
  currentUserText: string;
}): string {
  const lines = [
    "## WorkStream Continuation Decision Envelope",
    "Decision Source: the first model request decides from the current user instruction and durable WorkStream candidates.",
    "Decision Authority: the current user instruction is authoritative for whether to continue, modify, pause, cancel, or start different work.",
    "Current User Instruction:",
    input.currentUserText.trim() || "(empty)",
    "Continuation Candidates:",
  ];
  for (const candidate of input.candidates) {
    lines.push(...renderCandidate(candidate));
  }
  lines.push("Decision Contract:");
  lines.push("- Continue a candidate only when the current instruction semantically asks to continue, repair, review, modify, or supply missing user-owned action for that work.");
  lines.push("- If the current instruction asks for unrelated work, follow it as the active objective and leave candidates untouched unless a structured tool update is required.");
  lines.push("- Do not decide from phrase dictionaries, typo dictionaries, final-answer prose, task-id mentions, or locale-specific regexes.");
  lines.push("- Do not ask the user what to do merely because a recoverable WorkStream exists; ask only for a genuine user-owned blocker.");
  return lines.join("\n");
}

function renderCandidate(candidate: WorkStreamResumeCandidate): string[] {
  const checkpoint = candidate.checkpoint;
  const lines = [
    `- WorkStream ID: ${checkpoint.workStreamId}`,
    `  Title: ${checkpoint.title}`,
    `  State: ${checkpoint.state}`,
    `  Phase: ${checkpoint.currentPhase ?? "none"}`,
    `  Tracking Mode: ${checkpoint.trackingMode}`,
    `  Closeout Strategy: ${checkpoint.closeoutStrategy}`,
    `  Todo List ID: ${checkpoint.todoListId}`,
    `  Active Step ID: ${checkpoint.activeStepId ?? "none"}`,
  ];
  if (checkpoint.blocker) {
    lines.push(`  Typed Blocker: ${checkpoint.blocker.kind}:${checkpoint.blocker.reason}`);
  }
  lines.push("  Open Todo Slice:");
  for (const item of checkpoint.activeItems.slice(0, MAX_ITEMS_PER_CANDIDATE)) {
    lines.push(`  - ${item.id}:${item.status}:${item.phase ?? "none"}:${item.label}`);
  }
  appendRefs(lines, "Evidence Refs", checkpoint.evidenceRefs);
  appendRefs(lines, "Validation Refs", checkpoint.validationRefs);
  return lines;
}

function appendRefs(
  lines: string[],
  title: string,
  refs: WorkStreamResumeCheckpoint["evidenceRefs"],
): void {
  if (refs.length === 0) return;
  lines.push(`  ${title}:`);
  for (const ref of refs.slice(0, MAX_REFS_PER_CANDIDATE)) {
    lines.push(`  - ${ref.kind}:${ref.id}`);
  }
}

function requiredProfilesForCandidates(candidates: WorkStreamResumeCandidate[]): ButlerToolProfile[] {
  const profiles = new Set<ButlerToolProfile>();
  if (candidates.some((candidate) => candidate.checkpoint.trackingMode === "ledger")) profiles.add("project");
  if (candidates.some((candidate) => workspaceProfileNeeded(candidate.checkpoint))) {
    profiles.add("workspace");
  }
  return [...profiles];
}

function requiredToolsForCandidates(candidates: WorkStreamResumeCandidate[]): string[] {
  const tools = new Set([
    "update_todo_list",
    "list_todo_list",
    "list_work_streams",
    "update_work_stream_state",
    "get_context_monitor",
  ]);
  if (candidates.some((candidate) => candidate.checkpoint.trackingMode === "ledger")) {
    tools.add("project_ledger_status");
    tools.add("project_ledger_show");
  }
  return [...tools].sort();
}

function workspaceProfileNeeded(checkpoint: WorkStreamResumeCheckpoint): boolean {
  return checkpointNeedsWorkspaceProfile(checkpoint);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mergeStringArrays(...values: string[][]): string[] {
  return [...new Set(values.flat().map((value) => value.trim()).filter(Boolean))];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
