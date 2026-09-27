import type { ShowcaseGuidance } from "../../showcase";
import { ScrollArea } from "../ScrollArea";
import { Typo } from "../../components/Typo";
import { MessageRow } from "../MessageRow";
import { ConversationScroll, ConversationScrollToBottomButton, ConversationShell, MessageListSurface } from "./index";

// #region recipe: Conversation with a jump-to-latest button
function Thread() {
  return (
    <ConversationShell composerReserve={24}>
      <ConversationScroll>
        <MessageListSurface>
          <MessageRow role="user"><Typo.Body as="p">Why do the settings pages feel flat?</Typo.Body></MessageRow>
          <MessageRow role="assistant"><Typo.Body as="p">Section descriptions match the field labels, so the page reads as one long list.</Typo.Body></MessageRow>
        </MessageListSurface>
      </ConversationScroll>
      <ConversationScrollToBottomButton ariaLabel="Jump to latest" hasUnreadMessages onScrollToBottom={() => undefined}>New messages</ConversationScrollToBottomButton>
    </ConversationShell>
  );
}
// #endregion

/** Viewer frame only: the shell fills its parent's height. */
function Framed() {
  return <div style={{ height: 260 }}><Thread /></div>;
}

export const guidance: ShowcaseGuidance = {
  purpose: "The conversation column: scroll container, readable message width, composer reserve and the jump-to-latest button.",
  whenToUse: ["The message timeline of a conversation or an observer transcript"],
  whenNotToUse: [
    { when: "A generic scrolling region", use: "ScrollArea" },
    { when: "One message", use: "MessageRow" },
  ],
  recipes: [{ name: "Conversation with a jump-to-latest button", description: "composerReserve keeps the last message clear of the floating composer.", render: () => <Framed /> }],
  doDont: [
    {
      do: { caption: "The shell owns scroll, width and the composer reserve.", render: () => <Framed /> },
      dont: { caption: "Messages in a plain ScrollArea sit under the composer.", render: () => <ScrollArea maxHeight="xs"><MessageRow role="user">Hidden under the composer</MessageRow></ScrollArea> },
    },
  ],
  content: ["The jump button says what is below (New messages) or where it goes (Jump to latest)."],
  accessibility: ["Auto-scroll only when already at the bottom or while sending; the jump button is keyboard reachable."],
  tokens: ["--composer-reserve", "--page-max-width-reading", "--conversation-bg"],
};
