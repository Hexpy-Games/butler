import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { AppleReminder, Globe2, PanelLeft, PanelRightClose, Trash2 } from "../Icons";
import { IconButton } from "./IconButton";

// #region recipe: Titlebar panel toggles
function PanelToggles() {
  return (
    <ButtonContainer size="icon-sm">
      <IconButton label="Hide left panel"><PanelLeft size="md" /></IconButton>
      <IconButton label="Hide right panel"><PanelRightClose size="md" /></IconButton>
    </ButtonContainer>
  );
}
// #endregion

// #region recipe: Pane toggle fills with its pane's surface
function PaneToggleOn({ asideOpen = true, browserOpen = false }: { asideOpen?: boolean; browserOpen?: boolean }) {
  return (
    <ButtonContainer size="icon-sm">
      <IconButton label="Session info" pane="aside" pressed={asideOpen} tone={asideOpen ? "butler" : "default"}>
        <AppleReminder size="md" />
      </IconButton>
      <IconButton label={browserOpen ? "Hide browser" : "Show browser"} pane="browser" pressed={browserOpen}
        tone={browserOpen ? "butler" : "default"}><Globe2 size="md" /></IconButton>
    </ButtonContainer>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "An icon-only action with a required label that doubles as its tooltip.",
  whenToUse: ["An action whose icon is universally understood (close, back, panel toggles)", "Compact row or toolbar actions"],
  whenNotToUse: [
    { when: "The action needs words to be understood", use: "Button" },
    { when: "Copying text with confirmation", use: "CopyButton" },
    { when: "Saving or another one-shot action that confirms on the button", use: "DoneIconButton" },
    { when: "A rounded chip with an icon and text", use: "PillButton" },
  ],
  recipes: [
    { name: "Titlebar panel toggles", description: "Group icon buttons with ButtonContainer size icon-sm.", render: () => <PanelToggles /> },
    {
      name: "Pane toggle fills with its pane's surface",
      description: "A title-bar toggle that opens a pane declares the pane (pane=\"aside\" | \"browser\" | \"viewer\"). While it is open it passes pressed and tone=\"butler\": the button fills with that pane's own surface, opaque, so it reads as joined to its pane. The label says what a press does.",
      render: () => <PaneToggleOn />,
    },
  ],
  doDont: [
    {
      do: { caption: "A toggle that opens a pane names it: open, it fills with that pane's surface.", render: () => <PaneToggleOn asideOpen={false} browserOpen /> },
      dont: { caption: "selected (the generic grey) on a pane toggle: it neither matches the pane nor announces the state.", render: () => <IconButton label="Hide browser" selected><Globe2 size="md" /></IconButton> },
    },
    {
      do: { caption: "The label says what happens; the tooltip shows it on hover and focus.", render: () => <IconButton label="Delete row"><Trash2 size="md" /></IconButton> },
      dont: { caption: "A text Button with only an icon loses the tooltip and the square hit target.", render: () => <Button variant="ghost" iconStart={<Trash2 size="md" />} aria-label="Delete row" /> },
    },
  ],
  content: [
    "opticalAlign=\"top-end\" lines the icon, not the hit area, up with a card corner.",
    "Labels are imperative and specific: Hide left panel, Delete row, not Toggle or Action.",
    "tone colours the icon only: butler (ink blue) for an open Butler surface, riso while Butler acts; indicator adds the riso dot, badge a count (put the count in the label too).",
    "pane names the pane a title-bar toggle opens: aside (세션 정보, --tinted-glass-tint), browser (--browser-pane-bg), viewer (a card pane such as the file viewer, --shell-card-bg). While pressed, the fill is that token made opaque, resolved where the button sits, so a shell's override (the cards frame's browser sheet) applies. Toggles that open a dialog or a menu (the task graph, ⋯) declare no pane.",
  ],
  accessibility: [
    "label becomes aria-label; the Tooltip is skipped for menu triggers (aria-haspopup) so it never covers the menu.",
    "selected marks an open menu trigger; hit targets grow to 44px on touch.",
    "pressed sets aria-pressed; it paints a fill only with pane (the open pane's surface). The focus ring is unchanged in every tone and on the fill; hover lays --selection over the fill.",
  ],
  tokens: ["--control-height-md", "--selection", "--radius-pill", "--focus-ring", "--control-hit-target", "--butler-ink-blue", "--butler-ink-pink", "--tinted-glass-tint", "--browser-pane-bg", "--shell-card-bg"],
};
