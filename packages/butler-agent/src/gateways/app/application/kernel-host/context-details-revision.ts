import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { compactionSnapshotRevision } from "../../../../agent/context/compaction.ts";
import { sessionHintForRow } from "../../domain/sessions/session-read-model.ts";
import { promptCacheMetricsRevision } from "../../../../integrations/providers/prompt-cache-metrics.ts";
import { contextMetricsRevision } from "../../../../operations/metrics/context-monitor.ts";
import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";

/**
 * Build the cheap revision used by the bounded context-details cache. Every
 * input here is either a small indexed row or a file stat; the expensive
 * bounded message/artifact projection is only read after this key changes.
 */
export function buildContextDetailsRevision(
  kernel: AppStoreKernel,
  sessionId: string,
): string {
  const latestTurn = kernel.sessionRecords.latestTurn(sessionId);
  const chat = kernel.getChatRow(sessionId);
  const project = chat?.project_id
    ? kernel.getProjectRow(chat.project_id)
    : null;
  const settingsRow = kernel.db
    .query<{ updated_at: string | null; value_json: string }, [string]>(
      "SELECT updated_at, value_json FROM app_settings WHERE key = ?",
    )
    .get("settings");
  const settingsRevision = hashRevision(
    `${settingsRow?.updated_at ?? ""}:${settingsRow?.value_json ?? ""}`,
  );
  return [
    kernel.sessionRecords.latestMessageRevision(sessionId),
    latestTurn?.id ?? "",
    latestTurn?.state ?? "",
    latestTurn?.updated_at ?? "",
    kernel.sessionControls.revision(sessionId),
    settingsRevision,
    fileRevision(join(kernel.butlerData, "butler.config.json")),
    fileRevision(join(kernel.butlerData, "personas", "active.md")),
    fileRevision(join(kernel.butlerData, "eol.md")),
    chat?.kind ?? "",
    chat?.updated_at ?? "",
    project?.id ?? "",
    project?.updated_at ?? "",
    project?.workspace_path ?? "",
    kernel.messageFiles.artifactRevision(sessionId),
    kernel.messageFiles.countForSession(sessionId),
    promptCacheMetricsRevision(kernel.butlerData),
    contextMetricsRevision(kernel.butlerData),
    compactionSnapshotRevision({
      butlerData: kernel.butlerData,
      sessionId: sessionHintForRow(sessionId),
    }),
  ].join("\u001f");
}

function fileRevision(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function hashRevision(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
