import { Bot, MessageAvatarBlock } from "@/butler-ds";

interface MessageAvatarProps {
  role: string;
  isCompactionEvent: boolean;
}

export function MessageAvatar({
  role,
  isCompactionEvent,
}: MessageAvatarProps) {
  if (isCompactionEvent) return null;
  if (role === "assistant") return null;
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
