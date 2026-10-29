import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SubtaskView } from "@/app/types.ts";
import { CircleAlert, IconButton, IconSlot, Play, Typo } from "@/butler-ds";
import { subtaskProgress, subtaskStateLabel } from "./subtasks.ts";

/**
 * A subtask row's trailing slot, the same in the panel and the sidebar:
 * the plan step while working, resume while paused, the alert while it
 * needs approval.
 */
export function SubtaskMark({ parentId, subtask, size, onActionHover }: {
  parentId: string; subtask: SubtaskView; size: "sm" | "sidebar"; onActionHover?: (over: boolean) => void;
}) {
  useAppLocale();
  const [resuming, setResuming] = useState(false);
  const iconSize = size === "sm" ? "sm" : undefined;
  if (subtask.state === "paused") return <IconButton label={appCopy.conversation.work.resumeInterrupted}
    data-test-class="subtask-resume" disabled={resuming}
    onPointerEnter={() => onActionHover?.(true)} onPointerLeave={() => onActionHover?.(false)}
    onClick={event => {
      event.stopPropagation();
      setResuming(true);
      void useButlerStore.getState().resumeObservedSteward(subtask.relation_id, parentId).finally(() => setResuming(false));
    }}><Play size={iconSize} /></IconButton>;
  if (subtask.state === "needs_approval") return <IconSlot size={size} minHeight="line" passive role="status"
    aria-label={subtaskStateLabel(subtask.state)} data-test-class="subtask-attention"><CircleAlert size={iconSize} /></IconSlot>;
  const progress = subtaskProgress(subtask);
  // The row's name says the step in words; the digits are decoration.
  return progress ? <Typo.Caption tone="secondary" numeric="tabular" wrap="nowrap" aria-hidden data-test-class="subtask-progress">{progress}</Typo.Caption> : null;
}
