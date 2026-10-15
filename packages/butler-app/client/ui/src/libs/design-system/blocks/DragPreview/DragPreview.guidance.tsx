import type { ShowcaseGuidance } from "../../showcase";
import { Typo } from "../../components/Typo";
import { DragPreview } from "./DragPreview";

const CROP = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 60'%3E%3Crect width='60' height='60' fill='%23dfe4ea'/%3E%3Crect x='22' y='12' width='16' height='24' rx='4' fill='%23353a42'/%3E%3C/svg%3E";

// #region recipe: Dragging two picks
function TwoPicks() {
  return <DragPreview kind="elements" images={[{ src: CROP }, { src: CROP }]} />;
}
// #endregion

// #region recipe: Dragging a tab
function LiftedTab() {
  return <DragPreview kind="tab" title="Search results — Shop" />;
}
// #endregion

// #region recipe: Following the pointer
function FollowingThePointer() {
  // In the drag handler: setPointer({ x: event.clientX, y: event.clientY }) on every move; `at` omitted ends floating.
  const pointer = { x: 24, y: 16 };
  return (
    <div style={{ position: "relative", height: 110 }}>
      <DragPreview kind="elements" images={[{ src: CROP }, { src: CROP }]} count={3} at={pointer} strategy="absolute" />
    </div>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "What follows the pointer while picks or a browser tab are dragged: stacked crops with a count, or the lifted tab, with an invalid badge; static or floating at the pointer.",
  whenToUse: [
    "The drag image for picked elements (to the chat, a conversation, the library)",
    "A tab dragged from the pane to the sidebar",
    "A drag the App draws itself (no native drag image): floating at the pointer",
  ],
  whenNotToUse: [
    { when: "Reordering rows inside the sidebar", use: "NavDropTarget" },
    { when: "Reordering tabs inside the strip", use: "TabStrip" },
  ],
  recipes: [
    { name: "Dragging two picks", description: "Two crops, turned apart, with the count.", render: () => <TwoPicks /> },
    { name: "Dragging a tab", description: "The strip's tab, lifted on --shadow-drag-lift.", render: () => <LiftedTab /> },
    {
      name: "Following the pointer",
      description: "Floating mode: pass the pointer as `at` on every move. `fixed` (default) takes clientX/Y over the window; `absolute` takes a positioned layer's pixels (the overlay renderer).",
      render: () => <FollowingThePointer />,
    },
  ],
  doDont: [
    {
      do: { caption: "Flip `invalid` over a target that cannot take the payload; the target shows the reason.", render: () => <DragPreview kind="elements" images={[{ src: CROP }]} invalid /> },
      dont: { caption: "Do not put words in the preview; the drop label beside the target says what will happen.", render: () => <Typo.Caption>Drop here to attach 2 elements</Typo.Caption> },
    },
  ],
  content: ["Numbers only on the badge (12, 99+).", "Crops sit whole on the matte (contain); never pre-crop them to fill the card."],
  accessibility: [
    "Purely visual (aria-hidden); drags have a keyboard path elsewhere (menus: Add to chat, Move to conversation).",
    "Floating mode never takes the pointer; the lift-in is dropped under reduced motion.",
  ],
  tokens: ["--shadow-drag-lift", "--accent", "--color-danger", "--radius-control", "--z-drag"],
};
