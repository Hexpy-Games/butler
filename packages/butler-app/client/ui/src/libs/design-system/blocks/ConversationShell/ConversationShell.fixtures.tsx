import { ConversationScroll, ConversationShell, MessageListSurface } from "./ConversationShell";
import { MessageRow } from "../MessageRow";

export function ConversationShellFixture() {
  return (
    <ConversationShell composerReserve={160}>
      <ConversationScroll>
        <MessageListSurface>
          <MessageRow role="assistant" dataTestClass="message assistant">
            Conversation shell fixture message.
          </MessageRow>
        </MessageListSurface>
      </ConversationScroll>
    </ConversationShell>
  );
}
