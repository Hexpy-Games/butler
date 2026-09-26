import type { ReactNode } from "react";
import { ButlerThinkingMark } from "@/components/common/ButlerThinkingMark.tsx";
import { MessageStatusLabel } from "@/butler-ds";

export type AssistantStatusVisualState =
  | "active"
  | "complete"
  | "failed"
  | "cancelled";

export function AssistantStatusLabel({
  children,
  label,
  markTheme,
  state,
}: {
  children: ReactNode;
  label: string;
  markTheme: "dark" | "light";
  state: AssistantStatusVisualState;
}) {
  return (
    <MessageStatusLabel
      dataTestClass="assistant-status-label"
      mark={
        <span data-test-class={`assistant-status-mark-${state}`}>
          <ButlerThinkingMark
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
