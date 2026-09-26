import type { ShowcaseGuidance } from "../../showcase";
import { MessageRow } from "../../blocks/MessageRow";
import { Copy } from "../Icons";
import { Typo } from "../Typo";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./ContextMenu";

// #region recipe: Copy from a system message
function SystemMessageMenu() {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <MessageRow role="system" compactionEvent><Typo.Body>Compacted 42 earlier turns into a summary.</Typo.Body></MessageRow>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem><Copy size="sm" /><span>Copy</span></ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Secondary actions on right-click or long-press of a piece of content.",
  whenToUse: ["Offer copy or branch actions on messages without a visible button"],
  whenNotToUse: [
    { when: "The only way to reach an action", use: "DropdownMenu" },
    { when: "A visible row menu", use: "OverflowActionMenu" },
  ],
  recipes: [{ name: "Copy from a system message", description: "The trigger wraps the content with asChild; items mirror visible actions.", render: () => <SystemMessageMenu /> }],
  doDont: [
    {
      do: { caption: "Context menus duplicate actions that also exist elsewhere.", render: () => <SystemMessageMenu /> },
      dont: { caption: "Hiding the only delete action behind right-click makes it undiscoverable.", render: () => <Typo.Body>Right-click to delete (nowhere else)</Typo.Body> },
    },
  ],
  content: ["Same wording as the visible action (Copy, Branch from here)."],
  accessibility: ["Keyboard: the context-menu key or Shift+F10 opens it; items are menuitems."],
  tokens: ["--menu-item-height", "--radius-popover", "--motion-menu", "--z-popover"],
};
