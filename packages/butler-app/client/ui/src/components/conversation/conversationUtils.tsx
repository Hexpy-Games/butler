import {
  resolveAppearanceTheme,
} from "@/app/utils.ts";
import { projectCompletedWorkBlocks } from "@/app/conversation-progress";
import type {
  MessageRecord,
  TurnProgressSnapshot,
  WorkBlockView,
  SettingsView as SettingsData,
} from "@/app/types.ts";
import {
  isTerminalActivityState,
  toolchainRowsForBlock,
} from "./toolchainUtils";

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_COMPOSER_RESERVE = 170;
export const COMPOSER_FLOAT_BOTTOM = 28;
export const COMPOSER_CONTENT_GAP = 20;
export const MESSAGE_LIST_TOP_PADDING = 32;
export const MESSAGE_FILE_URL_PATTERN =
  /^\/message-files\/file-[0-9a-f-]{36}$/iu;

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function messageFileUrl(attachment: { url: string }): string {
  if (!MESSAGE_FILE_URL_PATTERN.test(attachment.url)) return "#";
  const serverUrl =
    typeof window !== "undefined" ? window.butlerApp?.serverUrl : undefined;
  return serverUrl
    ? new URL(attachment.url, serverUrl).toString()
    : attachment.url;
}

export function resolveButlerMarkTheme(
  theme: SettingsData["appearance_theme"],
): "dark" | "light" {
  return resolveAppearanceTheme(theme);
}

export function finalWorkBlocksForMessage(
  message: MessageRecord,
  turnProgress: Record<string, TurnProgressSnapshot> | null | undefined,
): WorkBlockView[] {
  if (message.role !== "assistant" || !message.turn_id) return [];
  return finalWorkBlocksFromSnapshot(message, turnProgress?.[message.turn_id]);
}

export function finalWorkBlocksFromSnapshot(
  message: MessageRecord,
  snapshot: TurnProgressSnapshot | null | undefined,
): WorkBlockView[] {
  if (message.role !== "assistant" || !message.turn_id) return [];
  if (!snapshot) return [];
  const snapshotState = snapshot.state ?? "";
  const rows = isTerminalActivityState(snapshotState)
    ? (snapshot.safe_progress_rows ?? []).map((row) =>
        isTerminalActivityState(row.state)
          ? row
          : { ...row, state: snapshotState },
      )
    : (snapshot.safe_progress_rows ?? []);
  return projectCompletedWorkBlocks(rows)
    .filter((block) => toolchainRowsForBlock(block).length > 0)
    .slice(-6);
}
