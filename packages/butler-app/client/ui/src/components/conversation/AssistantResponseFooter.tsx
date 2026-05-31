import { Copy } from "@/butler-ds";
import { MessageFooter } from "@/butler-ds";
import type { AssistantFooterMeta } from "./messageFooterMeta";

export function AssistantResponseFooter({
  copied,
  meta,
  onCopy,
}: {
  copied: boolean;
  meta: AssistantFooterMeta | null;
  onCopy: () => void;
}) {
  return (
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
  );
}
