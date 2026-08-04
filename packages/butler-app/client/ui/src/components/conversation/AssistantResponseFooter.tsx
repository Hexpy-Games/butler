import { Copy, MessageFooter, MessageStatusRow, Typo } from "@/butler-ds";
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
}: {
  copied: boolean;
  meta: AssistantFooterMeta | null;
  onCopy: () => void;
  status?: string;
}) {
  const markTheme = useButlerMarkTheme();
  const terminalStatus = terminalAssistantStatus(status);
  return (
    <>
      <MessageFooter>
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy assistant response"
        >
          <Copy size={14} />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
        {meta?.durationLabel && <span>Worked for {meta.durationLabel}</span>}
        {meta?.timeLabel && (
          <time dateTime={meta.completedAtIso ?? undefined}>{meta.timeLabel}</time>
        )}
      </MessageFooter>
      {terminalStatus ? (
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
  if (status === "failed") return { label: "답변 실패", state: "failed" };
  if (status === "cancelled") {
    return { label: "답변 중지", state: "cancelled" };
  }
  if (status && NON_TERMINAL_ASSISTANT_STATUSES.has(status)) return null;
  return { label: "답변 완료", state: "complete" };
}
