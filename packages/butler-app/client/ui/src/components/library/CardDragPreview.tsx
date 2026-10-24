import { DragPreview } from "@/butler-ds";
import { libraryImageSource } from "../browser/libraryStore";
import { useCardDrag } from "./libraryCardDrag";

/** Follows the pointer while cards are dragged: their crops stacked with a count; invalid off target. */
export function CardDragPreview() {
  const drag = useCardDrag();
  if (!drag.items.length || drag.x === undefined || drag.y === undefined) return null;
  return <DragPreview kind="elements" at={{ x: drag.x, y: drag.y }} invalid={!drag.target} count={drag.items.length}
    images={drag.items.flatMap(item => { const src = libraryImageSource(item, 200); return src ? [{ src }] : []; })} />;
}
