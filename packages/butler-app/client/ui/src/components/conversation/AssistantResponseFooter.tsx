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
  bubble = false,
  timeOnly = false,
  copied,
  meta,
  onCopy,
  status,
  suppressTerminalStatus = false,
  actions,
}: {
  bubble?: boolean;
  timeOnly?: boolean;
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
  // A live (e.g. streaming) answer has not finished: no worked-for duration or finish time yet.
  const settledMeta = status && NON_TERMINAL_ASSISTANT_STATUSES.has(status) ? null : meta;
  return (
    <>
      <MessageFooter>
        {!timeOnly && <CopyButton
          copied={copied}
          label={appCopy.conversation.messageActions.copyMessage}
          copiedLabel={appCopy.conversation.messageActions.copied}
          aria-label={appCopy.interfacePanels.copyResponse}
          onCopy={onCopy}
        />}
        {!timeOnly && actions}
        {!timeOnly && !bubble && settledMeta?.durationLabel && <span>{appCopy.interfaceTemplates.workedFor(settledMeta.durationLabel)}</span>}
        {settledMeta?.timeLabel && (
          <Typo.Text as="time" dateTime={settledMeta.completedAtIso ?? undefined} numeric="tabular">
            {settledMeta.timeLabel}
          </Typo.Text>
        )}
      </MessageFooter>
      {terminalStatus && !suppressTerminalStatus && !(bubble && terminalStatus.state === "complete") ? (
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
