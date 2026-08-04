import type { ReactNode } from "react";
import { ButlerMarkIcon } from "@/components/common/ButlerMarkIcon.tsx";
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
          {state === "active" ? (
            <ButlerThinkingMark state="working" theme={markTheme} />
          ) : (
            <ButlerMarkIcon theme={markTheme} title="" />
          )}
        </span>
      }
      title={label}
    >
      {children}
    </MessageStatusLabel>
  );
}
