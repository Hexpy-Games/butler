import type { ShowcaseGuidance } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { AppleReminder, Globe2, MoreHorizontal, PanelLeft, PanelRight } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { PanelHeader } from "../PanelHeader";
import { TitlebarShell } from "./TitlebarShell";

// #region recipe: Conversation titlebar
function ConversationTitlebar() {
  return (
    <TitlebarShell collapsed title="Token page review" subtitle={<Typo.Caption tone="secondary">butler · main</Typo.Caption>}
      leading={<IconButton label="Show left panel"><PanelLeft size="md" /></IconButton>}
      trailing={<IconButton label="Show right panel"><PanelRight size="md" /></IconButton>} />
  );
}
// #endregion

// #region recipe: Conversation titlebar beside the browser
function SplitTitlebar({ paneOpen, chatWidth }: { paneOpen: boolean; chatWidth: number }) {
  return (
    <TitlebarShell title="Shortcut conflicts" subtitle={<Typo.Caption tone="secondary">Butler app · Local</Typo.Caption>}
      titleActions={<IconButton label="Session actions" aria-haspopup="menu"><MoreHorizontal size="md" /></IconButton>}
      chatTrailing={<ButtonContainer size="icon-sm"><IconButton label="Session info · requests waiting for your answer" indicator>
        <AppleReminder size="md" /></IconButton></ButtonContainer>}
      splitChatWidth={paneOpen ? chatWidth : undefined}
      trailing={<ButtonContainer size="icon-sm"><IconButton label="Hide browser" pane="browser" pressed={paneOpen} tone={paneOpen ? "butler" : "default"}><Globe2 size="md" /></IconButton></ButtonContainer>} />
  );
}
// #endregion

// #region recipe: Nested screen with back
function NestedTitlebar() {
  return <TitlebarShell title="Travel" back={{ label: "Back to Scraps", onBack: () => undefined }} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The window titlebar: leading toggle, title, its actions and subtitle, chat-card controls that follow the browser split, trailing actions and window controls, draggable.",
  whenToUse: ["The top bar of the app window"],
  whenNotToUse: [
    { when: "A panel header", use: "PanelHeader" },
    { when: "A page title", use: "DashboardHeader" },
  ],
  recipes: [
    { name: "Conversation titlebar", description: "The leading control aligns with the title line; the bar is a drag region.", render: () => <ConversationTitlebar /> },
    { name: "Conversation titlebar beside the browser", description: "⋯ after the title line (title, then subtitle), 세션 정보 at the chat card's end, the browser toggle over the pane. Pass the split's chatWidth as splitChatWidth while the pane is open.", render: () => <SplitTitlebar paneOpen={false} chatWidth={400} /> },
    { name: "Nested screen with back", description: "Nested screens pass back; it goes up one level (⌘[ / Alt+←). Top-level screens pass nothing.", render: () => <NestedTitlebar /> },
  ],
  doDont: [
    {
      do: { caption: "Title and workspace subtitle stay on one line.", render: () => <ConversationTitlebar /> },
      dont: { caption: "A panel header in the window chrome has no drag region or window controls.", render: () => <PanelHeader title="Token page review" /> },
    },
  ],
  content: [
    "The title is the conversation title; the subtitle is project · branch.",
    "titleActions sit after the whole title line, title then subtitle (the conversation's ⋯); a truncated subtitle ends in its ellipsis and ⋯ follows it; chatTrailing holds the chat card's own controls (세션 정보); trailing holds what belongs to the window or the pane (the browser toggle).",
    "leadingSize=\"auto\" lets the leading slot hold a control at its own size (the standalone Browser's conversation button); the collapsed-sidebar inset is unchanged.",
  ],
  accessibility: ["titleActions come after the subtitle on screen and in reading order, so the title and subtitle read as one unit; focus order matches the screen (nothing focusable in the subtitle).", "A pane toggle (세션 정보, the browser, the file viewer) declares its pane (IconButton pane) and passes pressed and tone=\"butler\" while the pane is open: it fills with that pane's surface, opaque, and aria-pressed announces the state. The indicator dot stays on top of the fill. The task graph opens a dialog, not a pane: no pane, no fill.", "The indicator dot is hidden from assistive tech: say what it means in the label (“세션 정보 · 답을 기다리는 요청 있음”).", "dragRegion makes the bar a window drag region; controls inside it stay clickable (no-drag); window controls have labels.", "The back button is named by its label (“Back to Scraps”) and has the same action as ⌘[ / Alt+←."],
  tokens: ["--titlebar-height", "--titlebar-bg", "--chrome-floating-toggle-size", "--shell-card-inset", "--tinted-glass-tint", "--browser-pane-bg", "--shell-card-bg"],
};
