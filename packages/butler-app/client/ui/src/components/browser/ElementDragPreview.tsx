import { DragPreview } from "@/butler-ds";
import { useElementDrag } from "./elementDrag";

export function ElementDragPreview() {
  const drag = useElementDrag();
  if (!drag.tab || drag.x === undefined || drag.y === undefined) return null;
  return <DragPreview kind="elements" at={{ x: drag.x, y: drag.y }} invalid={!drag.target}
    count={drag.elements.length} images={drag.elements.map(element => ({ src: element.crop }))} />;
}
