import type { ReactNode } from "react";
import { ButlerThinkingMark, MessageStatusLabel } from "@/butler-ds";

export type AssistantStatusVisualState =
  | "active"
  | "complete"
  | "failed"
  | "cancelled";

export function AssistantStatusLabel({
  children,
  label,
  markKey,
  markTheme,
  state,
}: {
  children: ReactNode;
  label: string;
  /** Same key across remounts of one turn's status keeps the mark's morph going. */
  markKey?: string;
  markTheme: "dark" | "light";
  state: AssistantStatusVisualState;
}) {
  return (
    <MessageStatusLabel
      dataTestClass="assistant-status-label"
      mark={
        <span data-test-class={`assistant-status-mark-${state}`}>
          <ButlerThinkingMark
            morphKey={markKey}
            state={state === "active" ? "working" : "idle"}
            theme={markTheme}
          />
        </span>
      }
      shimmer={state === "active"}
      title={label}
    >
      {children}
    </MessageStatusLabel>
  );
}
