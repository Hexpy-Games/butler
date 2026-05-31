import { Bot, MessageAvatarBlock } from "@/butler-ds";
import { ButlerMarkIcon } from "@/components/common/ButlerMarkIcon.tsx";
import { ButlerThinkingMark } from "@/components/common/ButlerThinkingMark.tsx";

interface MessageAvatarProps {
  role: string;
  isCompactionEvent: boolean;
  isLatestAssistant: boolean;
  markTheme: "dark" | "light";
}

export function MessageAvatar({
  role,
  isCompactionEvent,
  isLatestAssistant,
  markTheme,
}: MessageAvatarProps) {
  if (isCompactionEvent) return null;

  if (role === "assistant") {
    return (
      <MessageAvatarBlock
        role="assistant"
        active={isLatestAssistant}
        data-test-class={
          isLatestAssistant ? "assistant-mark-live" : "assistant-mark-static"
        }
        aria-hidden="true"
      >
        {isLatestAssistant ? (
          <ButlerThinkingMark state="idle" theme={markTheme} />
        ) : (
          <ButlerMarkIcon theme={markTheme} title="" />
        )}
      </MessageAvatarBlock>
    );
  }

  if (role !== "system") return null;

  return (
    <MessageAvatarBlock
      role="system"
      data-test-class="message-avatar"
    >
      <Bot size={16} />
    </MessageAvatarBlock>
  );
}
