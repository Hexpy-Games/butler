import { createElement } from "react";
import { ConversationScrollToBottomButton } from "@/butler-ds";
import { appCopy } from "../../app/copy.ts";

interface ScrollToBottomButtonProps {
  hasUnreadMessages: boolean;
  onScrollToBottom: () => void;
}

export function ScrollToBottomButton({
  hasUnreadMessages,
  onScrollToBottom,
}: ScrollToBottomButtonProps) {
  const label = hasUnreadMessages
    ? appCopy.conversation.scrollToBottom.newMessagesLabel
    : appCopy.conversation.scrollToBottom.label;
  return createElement(
    ConversationScrollToBottomButton,
    {
      ariaLabel: appCopy.conversation.scrollToBottom.ariaLabel,
      hasUnreadMessages,
      onScrollToBottom,
    },
    label,
  );
}
