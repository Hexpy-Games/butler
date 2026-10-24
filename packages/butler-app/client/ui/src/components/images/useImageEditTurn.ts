import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { useButlerStore } from "@/app/store";
import type { ProgressRow } from "@/app/types";
import type { ImageAsset } from "./imageApi";
import { useImageOutputs } from "./useImageOutputs";

const EMPTY: ProgressRow[] = [];
const TERMINAL = new Set(["delivered", "completed", "failed", "cancelled", "denied"]);
/** Watches the accepted turn only: unrelated edits cannot become this editor's result. */
export function useImageEditTurn(image: string) {
  const [turn, setTurn] = useState<string>();
  const progress = useButlerStore(s => turn ? s.turnProgress[turn] : undefined);
  const message = useButlerStore(s => turn ? s.messages.find(m => m.role === "assistant" && m.turn_id === turn) : undefined);
  const rows = message?.turn_activity_rows ?? progress?.safe_progress_rows ?? EMPTY;
  const rejected = rows.some(row => row.safe_tool_name === "edit_image" && ["denied", "cancelled"].includes(row.state));
  const output = useImageOutputs(turn, rows, `${progress?.state}:${progress?.updated_at}:${message?.status}:${message?.updated_at}`);
  const [result, setResult] = useState<ImageAsset>();
  const next = output.images.find(asset => asset.parent_id === image);
  const ended = Boolean(turn && (TERMINAL.has(progress?.state ?? "") || TERMINAL.has(message?.status ?? "")));
  useEffect(() => {
    if (!turn || output.loading) return;
    if (next) { setResult(next); return; }
    if (ended && (!output.unavailable || output.failed || rejected)) {
      setTurn(undefined);
      if (output.failed) notifyStatus(appCopy.conversation.imageTools.failed, { tone: "error" });
    }
  }, [turn, next, ended, output.loading, output.failed, output.unavailable, rejected]);
  return { generating: Boolean(turn), result, accepted: setTurn,
    shown: () => { setResult(undefined); setTurn(undefined); } };
}
