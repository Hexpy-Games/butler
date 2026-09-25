import { useAppLocale } from "@/app/copy.ts";
import { CopyButton, MessageFooter, MessageStatusRow, Typo } from "@/butler-ds";
import type { ReactNode } from "react";
import { appCopy } from "@/app/copy.ts";
import type { AssistantFooterMeta } from "./messageFooterMeta";
import { AssistantStatusLabel } from "./AssistantStatusLabel";
import { useButlerMarkTheme } from "./hooks/useButlerMarkTheme";

const NON_TERMINAL_ASSISTANT_STATUSES = new Set([
  "queued",
  "pending",
  "accepted",
  "thinking",
  "streaming",
  "running",
  "waiting_for_form",
  "waiting_for_tool",
  "retrying",
  "cancelling",
]);

export function AssistantResponseFooter({
  copied,
  meta,
  onCopy,
  status,
  suppressTerminalStatus = false,
  actions,
}: {
  copied: boolean;
  meta: AssistantFooterMeta | null;
  onCopy: () => void;
  status?: string;
  suppressTerminalStatus?: boolean;
  actions?: ReactNode;
}) {
  useAppLocale();
  const markTheme = useButlerMarkTheme();
  const terminalStatus = terminalAssistantStatus(status);
  return (
    <>
      <MessageFooter>
        <CopyButton
          copied={copied}
          label={appCopy.conversation.messageActions.copyMessage}
          copiedLabel={appCopy.conversation.messageActions.copied}
          aria-label={appCopy.interfacePanels.copyResponse}
          onCopy={onCopy}
        />
        {actions}
        {meta?.durationLabel && <span>{appCopy.interfaceTemplates.workedFor(meta.durationLabel)}</span>}
        {meta?.timeLabel && (
          <Typo.Text as="time" dateTime={meta.completedAtIso ?? undefined} numeric="tabular">
            {meta.timeLabel}
          </Typo.Text>
        )}
      </MessageFooter>
      {terminalStatus && !suppressTerminalStatus ? (
        <MessageStatusRow dataTestClass="assistant-terminal-status-row">
          <AssistantStatusLabel
            label={terminalStatus.label}
            markTheme={markTheme}
            state={terminalStatus.state}
          >
            <Typo.Caption as="span">{terminalStatus.label}</Typo.Caption>
          </AssistantStatusLabel>
        </MessageStatusRow>
      ) : null}
    </>
  );
}

function terminalAssistantStatus(status?: string): {
  label: string;
  state: "complete" | "failed" | "cancelled";
} | null {
  if (status === "failed") return { label: appCopy.interfaceDetails.answerFailed, state: "failed" };
  if (status === "cancelled") {
    return { label: appCopy.interfaceDetails.answerStopped, state: "cancelled" };
  }
  if (status && NON_TERMINAL_ASSISTANT_STATUSES.has(status)) return null;
  return { label: appCopy.interfaceDetails.answerDone, state: "complete" };
}
