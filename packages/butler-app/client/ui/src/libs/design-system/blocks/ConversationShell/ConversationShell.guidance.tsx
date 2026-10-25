import type { ReactNode } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { ScrollArea } from "../ScrollArea";
import { Typo } from "../../components/Typo";
import { MarkdownContent } from "../MarkdownContent";
import { MessageRow } from "../MessageRow";
import { Wallpaper, type WallpaperSource } from "../Wallpaper";
import { ConversationScroll, ConversationScrollToBottomButton, ConversationShell, MessageListSurface } from "./index";
import { SessionDetails } from "./ConversationShell.asideDemo";

// #region recipe: Conversation with a jump-to-latest button
function Thread() {
  return (
    <ConversationShell composerReserve={24}>
      <ConversationScroll>
        <MessageListSurface>
          <MessageRow role="user"><Typo.Text as="div" wrap="pre">Why do the settings pages feel flat?</Typo.Text></MessageRow>
          <MessageRow role="assistant">
            <MarkdownContent><p>Section descriptions match the field labels, so the page reads as one long list.</p></MarkdownContent>
          </MessageRow>
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
          <MessageRow role="user"><Typo.Text as="div" wrap="pre">Plan today.</Typo.Text></MessageRow>
        </MessageListSurface>
      </ConversationScroll>
    </ConversationShell>
  );
}
// #endregion

// #region recipe: Session details in the aside
// Docked from a 960px shell (one flat Card per section, 12px apart); narrower it floats on glass while asideFloatOpen.
function ThreadWithDetails() {
  return (
    <ConversationShell composerReserve={24} asideLabel="Session details" asideFloatOpen
      aside={(layout) => <SessionDetails locale="en-US" layout={layout} />}>
      <ConversationScroll>
        <MessageListSurface>
          <MessageRow role="user"><Typo.Text as="div" wrap="pre">Draft the release notes too.</Typo.Text></MessageRow>
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
    {
      name: "Session details in the aside",
      description: "aside takes a function of the layout: docked, flat cards in the margin and the column moves left; floating, the sections bare on one glass panel.",
      render: () => <div style={{ height: 420 }}><ThreadWithDetails /></div>,
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
    "aside holds session details, not actions on a message: a few short sections (NavSection rows), empty ones hidden. Name it with asideLabel.",
    "A docked aside and a TabRail share the right margin: show one at a time. The shell holds a rail back until a leaving aside has gone, then fades it in.",
  ],
  accessibility: [
    "Auto-scroll only when already at the bottom or while sending; the jump button is keyboard reachable.",
    "The background layer is decorative: aria-hidden and never takes pointer input.",
    "The aside is a complementary landmark (asideLabel names it); its content scrolls on its own and focus rings keep --focus-ring-room.",
    "Opening or closing a docked aside glides the column on a transform (--motion-slow, emphasized) and the aside rides in or out with it; under reduced motion both move at once. The transcript keeps its scroll position.",
  ],
  tokens: ["--composer-reserve", "--page-max-width-reading", "--conversation-bg", "--tab-rail-clearance", "--tab-rail-shelf-height", "--motion-slow", "--motion-ease-emphasized"],
};
