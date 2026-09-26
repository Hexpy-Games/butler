import type { ShowcaseGuidance } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { PanelLeft, PanelRight } from "../../components/Icons";
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

export const guidance: ShowcaseGuidance = {
  purpose: "The window titlebar: leading toggle, title and subtitle, trailing actions and window controls, draggable.",
  whenToUse: ["The top bar of the app window"],
  whenNotToUse: [
    { when: "A panel header", use: "PanelHeader" },
    { when: "A page title", use: "DashboardHeader" },
  ],
  recipes: [{ name: "Conversation titlebar", description: "The leading control aligns with the title line; the bar is a drag region.", render: () => <ConversationTitlebar /> }],
  doDont: [
    {
      do: { caption: "Title and workspace subtitle stay on one line.", render: () => <ConversationTitlebar /> },
      dont: { caption: "A panel header in the window chrome has no drag region or window controls.", render: () => <PanelHeader title="Token page review" /> },
    },
  ],
  content: ["The title is the conversation title; the subtitle is project · branch."],
  accessibility: ["Controls inside the drag region stay clickable (no-drag); window controls have labels."],
  tokens: ["--titlebar-height", "--titlebar-bg", "--chrome-floating-toggle-size"],
};
