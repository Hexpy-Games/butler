import type { ShowcaseGuidance } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Archive, PencilLine, Trash2 } from "../../components/Icons";
import { OverflowActionMenu } from "./OverflowActionMenu";

// #region recipe: Session overflow menu
function SessionMenu() {
  return (
    <OverflowActionMenu label="Session actions" items={[
      { icon: <PencilLine size="sm" />, label: "Rename", onSelect: () => undefined },
      { icon: <Archive size="sm" />, label: "Archive", onSelect: () => undefined },
      { icon: <Trash2 size="sm" />, label: "Delete", onSelect: () => undefined, variant: "destructive" },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The More (…) button and menu for a row's actions, from a simple items array.",
  whenToUse: ["Rename, archive, delete and similar actions on a row or header"],
  whenNotToUse: [
    { when: "Grouped menus, submenus or radio items", use: "DropdownMenu" },
    { when: "One or two always-visible actions", use: "ButtonContainer" },
  ],
  recipes: [{ name: "Session overflow menu", description: "Destructive items go last with variant=\"destructive\".", render: () => <SessionMenu /> }],
  doDont: [
    {
      do: { caption: "One More button keeps rows calm.", render: () => <SessionMenu /> },
      dont: {
        caption: "A row of icon buttons for rarely used actions.",
        render: () => (
          <ButtonContainer size="icon-sm">
            <IconButton label="Rename"><PencilLine size="sm" /></IconButton>
            <IconButton label="Archive"><Archive size="sm" /></IconButton>
            <IconButton label="Delete"><Trash2 size="sm" /></IconButton>
          </ButtonContainer>
        ),
      },
    },
  ],
  content: ["Verbs, sentence case; label names the object (Session actions)."],
  accessibility: ["The trigger is a menu button (aria-haspopup); controlled open state keeps the row's hover visible."],
  tokens: ["--menu-item-height", "--radius-popover", "--color-danger"],
};
