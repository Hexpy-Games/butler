import type { ReactNode } from "react";
import { ChevronDownIcon } from "../../components/Icons";
import { PillButton } from "../../components/PillButton";
import { dsClass } from "../../lib/internal";
import styles from "./ConversationShell.module.css";

export function ConversationScrollToBottomButton({
  ariaLabel,
  children,
  hasUnreadMessages,
  onScrollToBottom,
}: {
  ariaLabel: string;
  children?: ReactNode;
  hasUnreadMessages: boolean;
  onScrollToBottom: () => void;
}) {
  return (
    <PillButton
      aria-label={ariaLabel}
      className={dsClass(styles.scrollToBottomButton)}
      surface="glass"
      data-test-class="scroll-to-bottom-button"
      data-column-glide=""
      data-unread-messages={hasUnreadMessages ? "true" : "false"}
      icon={<ChevronDownIcon size="md" />}
      onClick={onScrollToBottom}
    >
      {children}
    </PillButton>
  );
}
