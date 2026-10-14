import { DragPreview } from "@/butler-ds";
import { useCardDrag } from "./libraryCardDrag";

/** Follows the pointer while cards are dragged: their crops stacked with a count; invalid off target. */
export function CardDragPreview() {
  const drag = useCardDrag();
  if (!drag.items.length || drag.x === undefined || drag.y === undefined) return null;
  return <DragPreview kind="elements" at={{ x: drag.x, y: drag.y }} invalid={!drag.target} count={drag.items.length}
    images={drag.items.filter((item) => item.crop).map((item) => ({ src: item.crop! }))} />;
}
