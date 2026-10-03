import { useCallback, useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy";
import { notifyError } from "@/app/notifications";
import type { MessageRecord } from "@/app/types";

export function useMessageCopy() {
  const copyResetRef = useRef<number | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  useEffect(() => {
    return () => {
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
    };
  }, []);

  const copyAssistantMessage = useCallback(async (message: MessageRecord) => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedMessageId(message.id);
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(
        () => setCopiedMessageId(null),
        2000,
      );
    } catch (error) {
      notifyError(error, appCopy.interfacePanels.copyFailed, { id: `copy-${message.id}` });
    }
  }, []);

  const copyContextMenuText = useCallback(async (message: MessageRecord) => {
    try {
      const selectedText = window.getSelection()?.toString();
      const textToCopy = selectedText || message.text;
      await navigator.clipboard.writeText(textToCopy);
    } catch (error) {
      notifyError(error, appCopy.interfacePanels.copyFailed, { id: `copy-context-${message.id}` });
    }
  }, []);

  return { copiedMessageId, copyAssistantMessage, copyContextMenuText };
}
