import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { PanelLeft, PanelRightClose, Trash2 } from "../Icons";
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

export const guidance: ShowcaseGuidance = {
  purpose: "An icon-only action with a required label that doubles as its tooltip.",
  whenToUse: ["An action whose icon is universally understood (close, back, panel toggles)", "Compact row or toolbar actions"],
  whenNotToUse: [
    { when: "The action needs words to be understood", use: "Button" },
    { when: "Copying text with confirmation", use: "CopyButton" },
    { when: "A rounded chip with an icon and text", use: "PillButton" },
  ],
  recipes: [{ name: "Titlebar panel toggles", description: "Group icon buttons with ButtonContainer size icon-sm.", render: () => <PanelToggles /> }],
  doDont: [
    {
      do: { caption: "The label says what happens; the tooltip shows it on hover and focus.", render: () => <IconButton label="Delete row"><Trash2 size="md" /></IconButton> },
      dont: { caption: "A text Button with only an icon loses the tooltip and the square hit target.", render: () => <Button variant="ghost" iconStart={<Trash2 size="md" />} aria-label="Delete row" /> },
    },
  ],
  content: [
    "opticalAlign=\"top-end\" lines the icon, not the hit area, up with a card corner.",
    "Labels are imperative and specific: Hide left panel, Delete row, not Toggle or Action.",
    "tone colours the icon only: butler (ink blue) for an open Butler surface, riso while Butler acts; indicator adds the riso dot, badge a count (put the count in the label too).",
  ],
  accessibility: [
    "label becomes aria-label; the Tooltip is skipped for menu triggers (aria-haspopup) so it never covers the menu.",
    "selected marks an open menu trigger; hit targets grow to 44px on touch.",
    "pressed sets aria-pressed for toggles without a pressed fill (the browser toggle); the focus ring is unchanged in every tone.",
  ],
  tokens: ["--control-height-md", "--selection", "--radius-pill", "--focus-ring", "--control-hit-target", "--butler-ink-blue", "--butler-ink-pink"],
};
