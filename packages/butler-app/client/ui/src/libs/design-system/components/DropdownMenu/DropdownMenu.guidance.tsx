import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { IconButton } from "../IconButton";
import { Archive, MoreHorizontal, PencilLine, Trash2 } from "../Icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./DropdownMenu";

// #region recipe: Item actions menu
function ItemActions() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Session actions" aria-haspopup="menu"><MoreHorizontal size="md" /></IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8}>
        <DropdownMenuGroup>
          <DropdownMenuItem><PencilLine size="sm" /> Rename</DropdownMenuItem>
          <DropdownMenuItem><Archive size="sm" /> Archive</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive"><Trash2 size="sm" /> Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A menu of actions (and radio or checkbox choices) anchored to a trigger.",
  whenToUse: ["Several actions for one item behind a More button", "A view menu with radio and checkbox items"],
  whenNotToUse: [
    { when: "A row's overflow menu with icon items", use: "OverflowActionMenu" },
    { when: "Right-click actions on content", use: "ContextMenu" },
    { when: "Picking a value for a form", use: "Select" },
    { when: "A composer chooser with descriptions", use: "OptionMenu" },
  ],
  recipes: [{ name: "Item actions menu", description: "Group related actions; destructive items go last after a separator.", render: () => <ItemActions /> }],
  doDont: [
    {
      do: { caption: "Collapse three or more item actions into a menu.", render: () => <ItemActions /> },
      dont: {
        caption: "A row of buttons for rarely used actions crowds the row.",
        render: () => <ButtonContainer size="xs"><Button size="xs" variant="outline" text="Rename" /><Button size="xs" variant="outline" text="Archive" /><Button size="xs" variant="destructive" text="Delete" /></ButtonContainer>,
      },
    },
  ],
  content: ["DropdownMenuContent takes theme for the portalled surface (it renders outside the themed shell).", "Items start with a verb; keep them to two or three words."],
  accessibility: ["Triggers set aria-haspopup (IconButton then skips its tooltip); typeahead and arrows are instant."],
  tokens: ["--menu-item-height", "--radius-popover", "--motion-menu", "--motion-exit-menu", "--motion-scale-menu", "--z-popover"],
};
