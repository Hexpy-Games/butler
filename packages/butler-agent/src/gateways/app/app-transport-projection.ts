import { resolve } from "node:path";
import type { ArtifactRef } from "../core/contracts.ts";
import type { ProgressSummaryInput } from "./progress-summary.ts";
import {
  isRecord,
  safeOptionalNumber,
  safeOptionalShortText,
  safeOptionalShortToken,
  safeShortText,
} from "./projection-safe-values.ts";

const BUTLER_FINAL_ANSWER_OPEN = "<butler_final_answer>";
const BUTLER_FINAL_ANSWER_CLOSE = "</butler_final_answer>";

export function progressRowFromAppOutbound(
  actionId: string,
  message: Record<string, unknown>,
  metadata: Record<string, unknown>,
  timestamp: string,
): ProgressSummaryInput | null {
  if (metadata.kind === "tool_progress") {
    return {
      id: actionId,
      kind: safeOptionalShortToken(metadata.activityKind) ?? "used_tool",
      state: safeOptionalShortToken(metadata.state) ?? "running",
      safe_label: safeShortText(metadata.safeLabel, "Working"),
      safe_tool_name: safeOptionalShortText(metadata.toolName),
      safe_input_label: safeOptionalShortText(metadata.inputLabel),
      tool_call_id: safeOptionalShortToken(metadata.toolCallId),
      work_block_id: safeOptionalShortToken(metadata.workBlockId),
      work_block_label: safeOptionalShortText(metadata.workBlockLabel),
      work_decision_summary: safeOptionalShortText(metadata.decisionSummary),
      work_decision_rationale: safeOptionalShortText(
        metadata.decisionRationale,
      ),
      work_decision_next_step: safeOptionalShortText(metadata.decisionNextStep),
      work_decision_source: safeOptionalShortText(metadata.decisionSource),
      work_decision_evidence_refs: Array.isArray(metadata.decisionEvidenceRefs)
        ? metadata.decisionEvidenceRefs
        : undefined,
      safe_detail_rows: Array.isArray(metadata.detailRows)
        ? metadata.detailRows
        : undefined,
      created_at: timestamp,
    };
  }
  if (metadata.kind === "todo_progress") {
    return {
      id: safeOptionalShortToken(metadata.todoId) ?? actionId,
      kind: "todo",
      state: safeOptionalShortToken(metadata.state) ?? "thinking",
      safe_label: safeShortText(metadata.safeLabel, "Working"),
      safe_input_label: safeOptionalShortText(metadata.todoId),
      safe_order: safeOptionalNumber(metadata.safeOrder),
      safe_detail_rows: todoProgressDetailRows(metadata),
      created_at: timestamp,
    };
  }
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (metadata.kind === "intermediate" && text) {
    if (metadata.phase === "before_tool_execution") {
      const label = safeOptionalShortText(metadata.workBlockLabel) ??
        safeOptionalShortText(text) ??
        "Working";
      return {
        id: actionId,
        kind: "message",
        state: "running",
        safe_label: safeOptionalShortText(text) ?? label,
        work_block_id: safeOptionalShortToken(metadata.workBlockId) ?? actionId,
        work_block_label: label,
        work_decision_summary: safeOptionalShortText(metadata.decisionSummary),
        work_decision_rationale: safeOptionalShortText(
          metadata.decisionRationale,
        ),
        work_decision_next_step: safeOptionalShortText(metadata.decisionNextStep),
        work_decision_source: safeOptionalShortText(metadata.decisionSource),
        work_decision_evidence_refs: Array.isArray(metadata.decisionEvidenceRefs)
          ? metadata.decisionEvidenceRefs
          : undefined,
        created_at: timestamp,
      };
    }
    return {
      id: actionId,
      kind: "thinking",
      state: "running",
      safe_label: safeOptionalShortText(text) ?? "Working",
      created_at: timestamp,
    };
  }
  return null;
}

export function artifactRefsFromOutboundMessage(value: unknown): ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      id: safeShortText(item.id, "artifact"),
      kind: outboundArtifactKind(item.kind),
      title: safeShortText(item.title, "Artifact"),
      safePathLabel: safeOptionalShortText(item.safePathLabel),
      mimeType: safeOptionalShortText(item.mimeType),
      localPath: safeOptionalShortText(item.localPath),
      url: safeOptionalShortText(item.url),
      sizeBytes:
        typeof item.sizeBytes === "number" ? item.sizeBytes : undefined,
      createdAt: safeOptionalShortText(item.createdAt),
      metadata: isRecord(item.metadata) ? item.metadata : undefined,
    }));
}

export function artifactCandidatePaths(
  artifact: ArtifactRef,
  allowedRoots: string[],
): string[] {
  const candidates: string[] = [];
  const localPath = artifact.localPath?.trim();
  if (localPath) candidates.push(resolve(localPath));

  const safePathLabel = artifact.safePathLabel?.trim();
  if (safePathLabel) {
    for (const root of allowedRoots) {
      candidates.push(resolve(root, safePathLabel));
    }
  }

  return Array.from(new Set(candidates));
}

export function sanitizeAppTransportFinalText(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const openIndex = text.indexOf(BUTLER_FINAL_ANSWER_OPEN);
  if (openIndex < 0) return text;
  const bodyStart = openIndex + BUTLER_FINAL_ANSWER_OPEN.length;
  const closeIndex = text.indexOf(BUTLER_FINAL_ANSWER_CLOSE, bodyStart);
  if (closeIndex < 0) {
    return text
      .replaceAll(BUTLER_FINAL_ANSWER_OPEN, "")
      .replaceAll(BUTLER_FINAL_ANSWER_CLOSE, "")
      .trim();
  }

  const before = text.slice(0, openIndex).trim();
  const body = text.slice(bodyStart, closeIndex).trim();
  const after = text
    .slice(closeIndex + BUTLER_FINAL_ANSWER_CLOSE.length)
    .trim();
  if (before) return body || after;
  return [body, after].filter(Boolean).join("\n\n").trim();
}

function todoProgressDetailRows(
  metadata: Record<string, unknown>,
): ProgressSummaryInput["safe_detail_rows"] {
  const phase = safeOptionalShortText(metadata.phase);
  if (!phase) return undefined;
  return [
    {
      id: "phase",
      kind: "phase",
      safe_label: "Phase",
      safe_value: todoPhaseLabel(phase),
      state: safeOptionalShortToken(metadata.state) ?? "thinking",
    },
  ];
}

function todoPhaseLabel(phase: string): string {
  const normalized = phase.trim().toLowerCase();
  if (normalized === "orientation") return "구상";
  if (normalized === "planning") return "계획";
  if (normalized === "execution") return "실행";
  if (normalized === "review") return "검토";
  if (normalized === "consolidation") return "정리";
  if (normalized === "reporting") return "보고";
  return phase;
}

function outboundArtifactKind(value: unknown): ArtifactRef["kind"] {
  const kind = typeof value === "string" ? value : "";
  if (
    kind === "csv_file" ||
    kind === "table_file" ||
    kind === "chart_file" ||
    kind === "image" ||
    kind === "document" ||
    kind === "code" ||
    kind === "report" ||
    kind === "file"
  ) {
    return kind;
  }
  return "unknown";
}
