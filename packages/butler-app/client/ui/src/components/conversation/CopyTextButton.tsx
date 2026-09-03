import { useEffect, useRef, useState } from "react";
import { Copy, Tooltip } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";

const COPY_FEEDBACK_MS = 2000;

export function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch (error) {
      notifyError(error, appCopy.conversation.messageActions.copyFailed);
    }
  };
  const feedbackLabel = copied ? appCopy.conversation.messageActions.copied : label;
  return (
    <Tooltip label={feedbackLabel}>
      <button type="button" onClick={() => void copy()} aria-label={feedbackLabel}>
        <Copy size={14} />
      </button>
    </Tooltip>
  );
}
