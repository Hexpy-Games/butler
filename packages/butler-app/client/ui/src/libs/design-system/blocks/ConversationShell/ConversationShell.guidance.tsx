import type { ReactNode } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { ScrollArea } from "../ScrollArea";
import { Typo } from "../../components/Typo";
import { MessageRow } from "../MessageRow";
import { Wallpaper, type WallpaperSource } from "../Wallpaper";
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

// #region recipe: One background behind the conversation
// A stable source; the same layer stays mounted while the new chat gives way to the messages.
const CONVERSATION_BACKGROUND: WallpaperSource = { kind: "live", module: "butler.silk" };

function ThreadOverBackground() {
  return (
    <ConversationShell background={<Wallpaper scope="container" source={CONVERSATION_BACKGROUND} />} composerReserve={24}>
      <ConversationScroll>
        <MessageListSurface onColumnRect={(column) => void column}>
          <MessageRow role="user"><Typo.Body as="p">Plan today.</Typo.Body></MessageRow>
        </MessageListSurface>
      </ConversationScroll>
    </ConversationShell>
  );
}
// #endregion

/** Viewer frame only: the shell fills its parent's height. */
function Framed({ children = <Thread /> }: { children?: ReactNode }) {
  return <div style={{ height: 260 }}>{children}</div>;
}

export const guidance: ShowcaseGuidance = {
  purpose: "The conversation column: scroll container, readable message width, composer reserve and the jump-to-latest button.",
  whenToUse: ["The message timeline of a conversation or an observer transcript"],
  whenNotToUse: [
    { when: "A generic scrolling region", use: "ScrollArea" },
    { when: "One message", use: "MessageRow" },
    { when: "A wallpaper behind the new chat only (its wallpaper prop)", use: "PromptSuggestionList" },
    { when: "Live previews of Butler's tabs (pass it as the rail slot)", use: "TabRail" },
  ],
  recipes: [
    { name: "Conversation with a jump-to-latest button", description: "composerReserve keeps the last message clear of the floating composer.", render: () => <Framed /> },
    {
      name: "One background behind the conversation",
      description: "background mounts one layer for the new chat and its messages; onColumnRect gives the column's edges (on resize, never on scroll) for the layer's keep-out.",
      render: () => <Framed><ThreadOverBackground /></Framed>,
    },
  ],
  doDont: [
    {
      do: { caption: "The shell owns scroll, width and the composer reserve.", render: () => <Framed /> },
      dont: { caption: "Messages in a plain ScrollArea sit under the composer.", render: () => <ScrollArea maxHeight="xs"><MessageRow role="user">Hidden under the composer</MessageRow></ScrollArea> },
    },
  ],
  content: [
    "The jump button says what is below (New messages) or where it goes (Jump to latest).",
    "rail takes a TabRail and railView the conversation id: the column moves left only as far as needed, once per view.",
  ],
  accessibility: [
    "Auto-scroll only when already at the bottom or while sending; the jump button is keyboard reachable.",
    "The background layer is decorative: aria-hidden and never takes pointer input.",
  ],
  tokens: ["--composer-reserve", "--page-max-width-reading", "--conversation-bg", "--tab-rail-clearance", "--tab-rail-shelf-height"],
};
