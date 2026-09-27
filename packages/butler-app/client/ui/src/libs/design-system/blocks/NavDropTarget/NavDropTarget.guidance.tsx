import type { ShowcaseGuidance } from "../../showcase";
import { CollapsibleList } from "../../components/Collapsible";
import { MessageSquare } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { NavRow } from "../NavRow";
import { NavDropScope, NavDropTarget, NavRootDropZone } from "./NavDropTarget";

// #region recipe: Droppable rows with an insert slot
function DroppableRows() {
  return (
    <NavDropScope active aria-label="Chats">
      <CollapsibleList scope="chats">
        {["Weekly review", "Travel plan", "Reading list"].map((label, index) => (
          <NavDropTarget key={label} drop={index === 1 ? "before" : undefined} indicator={{ top: 0, height: 30 }} hint="Group together">
            <NavRow icon={<MessageSquare />} label={label} onClick={() => undefined} />
          </NavDropTarget>
        ))}
      </CollapsibleList>
      <NavRootDropZone>Move to space root</NavRootDropZone>
    </NavDropScope>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Drop feedback for navigation trees: an insert slot, a group ring and a root zone, driven by stable drop zones.",
  whenToUse: ["Reorder or group rows by dragging in the sidebar"],
  whenNotToUse: [
    { when: "Reordering cards in a settings list", use: "SortableCardList" },
    { when: "A static list", use: "NavSection" },
  ],
  recipes: [{ name: "Droppable rows with an insert slot", description: "NavDropScope marks the drag; rows must be CollapsibleList items.", render: () => <DroppableRows /> }],
  doDont: [
    {
      do: { caption: "The slot opens where the row lands; the target never moves.", render: () => <DroppableRows /> },
      dont: { caption: "Scaling the row under the pointer makes the zone flicker.", render: () => <Stack><NavRow label="Growing target (avoid)" /></Stack> },
    },
  ],
  content: ["Hints are verbs: Group together, Move to space root."],
  accessibility: ["Offer keyboard alternatives (row menus: Move to…) for every drag action."],
  tokens: ["--z-drop-indicator", "--z-drop-hint", "--drop-clip-margin", "--motion-base", "--accent"],
};
