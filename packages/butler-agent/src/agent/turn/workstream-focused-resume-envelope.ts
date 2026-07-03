import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type {
  WorkStreamResumeCheckpoint,
  WorkStreamResumeSelection,
} from "./workstream-checkpoint-resume-types.ts";
import type { ButlerToolProfile } from "../tools/profiles.ts";

export interface FocusedResumeEnvelope {
  prompt: string;
  requiredNativeTools: string[];
  requiredNativeToolProfiles: ButlerToolProfile[];
  ledgerRecords: FocusedProjectLedgerRecord[];
  checkpoint: WorkStreamResumeCheckpoint;
}

interface FocusedProjectLedgerRecord {
  id: string;
  kind: string;
  title: string;
  status: string;
  path: string | null;
}

export function buildFocusedResumeEnvelope(input: {
  butlerData: string;
  selection: WorkStreamResumeSelection;
  currentUserText: string;
}): FocusedResumeEnvelope | null {
  const checkpoint = input.selection.selected?.checkpoint;
  if (input.selection.state !== "resume_selected" || !checkpoint) return null;
  const ledgerRecords = hydrateFocusedProjectLedgerRecords({
    butlerData: input.butlerData,
    checkpoint,
  });
  const requiredNativeToolProfiles = requiredProfilesForCheckpoint(checkpoint);
  const requiredNativeTools = requiredToolsForCheckpoint(checkpoint, ledgerRecords);
  return {
    prompt: renderFocusedResumeEnvelope({
      checkpoint,
      currentUserText: input.currentUserText,
      requiredNativeTools,
      requiredNativeToolProfiles,
      ledgerRecords,
    }),
    requiredNativeTools,
    requiredNativeToolProfiles,
    ledgerRecords,
    checkpoint,
  };
}

export function turnMetadataWithFocusedResumePolicy(
  metadata: Record<string, unknown> | undefined,
  envelope: FocusedResumeEnvelope | null,
): Record<string, unknown> | undefined {
  if (!envelope) return metadata;
  return {
    ...(metadata ?? {}),
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
    focusedResume: {
      checkpointId: envelope.checkpoint.checkpointId,
      workStreamId: envelope.checkpoint.workStreamId,
      state: envelope.checkpoint.state,
      phase: envelope.checkpoint.currentPhase,
    },
  };
}

function renderFocusedResumeEnvelope(input: {
  checkpoint: WorkStreamResumeCheckpoint;
  currentUserText: string;
  requiredNativeTools: string[];
  requiredNativeToolProfiles: ButlerToolProfile[];
  ledgerRecords: FocusedProjectLedgerRecord[];
}): string {
  const checkpoint = input.checkpoint;
  const lines = [
    "## Focused WorkStream Resume Envelope",
    "Resume Source: durable WorkStream checkpoint selected before the first model request.",
    `Checkpoint ID: ${checkpoint.checkpointId}`,
    `WorkStream ID: ${checkpoint.workStreamId}`,
    `Chat ID: ${checkpoint.chatId ?? "none"}`,
    `Origin Turn ID: ${checkpoint.originatingTurnId ?? "none"}`,
    `User Message ID: ${checkpoint.userMessageId ?? "none"}`,
    `WorkStream Title: ${checkpoint.title}`,
    `WorkStream State: ${checkpoint.state}`,
    `WorkStream Phase: ${checkpoint.currentPhase ?? "none"}`,
    `Todo List ID: ${checkpoint.todoListId}`,
    `Active Step ID: ${checkpoint.activeStepId ?? "none"}`,
  ];
  if (checkpoint.statusNote) lines.push(`Status Note: ${checkpoint.statusNote}`);
  if (checkpoint.blocker) {
    lines.push(`Typed Blocker: ${checkpoint.blocker.kind}:${checkpoint.blocker.reason}`);
  }
  if (checkpoint.budgetSnapshot) {
    lines.push(
      `Logical Turn Budget: model_requests=${checkpoint.budgetSnapshot.modelRequestsUsed}/${checkpoint.budgetSnapshot.maxModelCalls}`,
    );
  }
  lines.push("Open Todo Slice:");
  lines.push(...checkpoint.activeItems.map((item) =>
    `- ${item.id}:${item.status}:${item.phase ?? "none"}:${item.label}`,
  ));
  if (checkpoint.evidenceRefs.length > 0) {
    lines.push("Checkpoint Evidence Refs:");
    lines.push(...checkpoint.evidenceRefs.slice(0, 12).map((ref) =>
      `- ${ref.kind}:${ref.id}`,
    ));
  }
  if (checkpoint.validationRefs.length > 0 || checkpoint.latestCompletionReview) {
    lines.push("Checkpoint Validation State:");
    if (checkpoint.latestCompletionReview) {
      lines.push(`- completion_review:${checkpoint.latestCompletionReview.status}`);
    }
    lines.push(...checkpoint.validationRefs.slice(0, 8).map((ref) =>
      `- ${ref.kind}:${ref.id}`,
    ));
  }
  if (input.ledgerRecords.length > 0) {
    lines.push("Relevant Project Ledger Records:");
    lines.push(...input.ledgerRecords.map((record) =>
      `- ${record.kind}:${record.id}:${record.status}:${record.title}`,
    ));
  }
  lines.push("Current User Instruction Delta:");
  lines.push(input.currentUserText.trim() || "(empty)");
  lines.push("Bounded First Model Tool Profile:");
  lines.push(`- profiles: ${input.requiredNativeToolProfiles.join(", ") || "startup"}`);
  lines.push(`- tools: ${input.requiredNativeTools.join(", ") || "none"}`);
  lines.push("Continuation Contract:");
  lines.push("- Continue this selected WorkStream before broad validation, review, or replanning.");
  lines.push("- Use the open todo slice as the execution target and update the same todo list as evidence changes.");
  lines.push("- Do not inspect broad recent conversation, unrelated WorkStreams, or full Project Ledger graphs unless checkpoint evidence is insufficient.");
  lines.push("- Final delivery is allowed only after this WorkStream reaches a legitimate deliverable state or records a typed blocker.");
  return lines.join("\n");
}

function hydrateFocusedProjectLedgerRecords(input: {
  butlerData: string;
  checkpoint: WorkStreamResumeCheckpoint;
}): FocusedProjectLedgerRecord[] {
  const projectId = input.checkpoint.projectId?.trim();
  if (!projectId || !/^[A-Za-z0-9._:-]{1,120}$/.test(projectId)) return [];
  const indexPath = join(input.butlerData, "project-ledger", "projects", projectId, "index", "project.json");
  if (!existsSync(indexPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
      records?: unknown;
    };
    const wanted = focusedLedgerRecordIds(input.checkpoint);
    return Array.isArray(parsed.records)
      ? parsed.records
        .map(focusedLedgerRecord)
        .filter((record): record is FocusedProjectLedgerRecord =>
          Boolean(record && wanted.has(record.id)),
        )
        .slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

function focusedLedgerRecordIds(checkpoint: WorkStreamResumeCheckpoint): Set<string> {
  return new Set([
    checkpoint.workStreamId,
    checkpoint.todoListId,
    checkpoint.activeStepId ?? "",
    ...checkpoint.activeItems.map((item) => item.id),
    ...checkpoint.linkedPlannedTaskIds,
  ].map((id) => id.trim()).filter(Boolean));
}

function focusedLedgerRecord(value: unknown): FocusedProjectLedgerRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = safeRecordText(record.id);
  const kind = safeRecordText(record.kind);
  if (!id || !kind) return null;
  return {
    id,
    kind,
    title: safeRecordText(record.title) || id,
    status: safeRecordText(record.status) || "unknown",
    path: safeRecordText(record.path) || null,
  };
}

function requiredProfilesForCheckpoint(
  checkpoint: WorkStreamResumeCheckpoint,
): ButlerToolProfile[] {
  const profiles = new Set<ButlerToolProfile>();
  if (checkpoint.projectId) profiles.add("project");
  if (
    checkpoint.currentPhase === "execution" ||
    checkpoint.currentPhase === "review" ||
    checkpoint.currentPhase === "consolidation" ||
    checkpoint.currentPhase === "reporting"
  ) {
    profiles.add("workspace");
  }
  return [...profiles];
}

function requiredToolsForCheckpoint(
  checkpoint: WorkStreamResumeCheckpoint,
  ledgerRecords: FocusedProjectLedgerRecord[],
): string[] {
  const tools = new Set([
    "update_todo_list",
    "list_todo_list",
    "list_work_streams",
    "update_work_stream_state",
    "get_context_monitor",
    "get_usage_monitor",
  ]);
  if (checkpoint.projectId || ledgerRecords.length > 0) {
    tools.add("project_ledger_status");
    tools.add("project_ledger_show");
  }
  return [...tools].sort();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mergeStringArrays(...values: string[][]): string[] {
  return [...new Set(values.flat().map((value) => value.trim()).filter(Boolean))];
}

function safeRecordText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 240) : "";
}
