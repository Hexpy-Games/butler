import { useCallback, useEffect, useRef, useState } from "react";
import { appCopy } from "@/app/copy";
import { notifyError } from "@/app/notifications";
import type { MessageRecord } from "@/app/types";

import { parseAnswerBlocks } from "../../../../../shared/answer-blocks-parse";
import { toMarkdown } from "../../../../../shared/answer-blocks-markdown";

import { gatewayImageSource } from "@/app/messageFileUrls";

function messageMarkdown(message: MessageRecord): string {
  const blocks = (message.answer_blocks ?? []).flatMap(set => {
    const spec = parseAnswerBlocks(set.spec);
    return spec ? [toMarkdown(spec, gatewayImageSource)] : [];
  });
  return [message.text, ...blocks].filter(Boolean).join("\n\n");
}

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
      await navigator.clipboard.writeText(messageMarkdown(message));
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
      const textToCopy = selectedText || messageMarkdown(message);
      await navigator.clipboard.writeText(textToCopy);
    } catch (error) {
      notifyError(error, appCopy.interfacePanels.copyFailed, { id: `copy-context-${message.id}` });
    }
  }, []);

  return { copiedMessageId, copyAssistantMessage, copyContextMenuText };
}
