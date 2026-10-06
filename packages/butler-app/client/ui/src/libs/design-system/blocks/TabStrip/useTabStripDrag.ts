import { PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useState } from "react";
import { movedAnnouncement, type TabStripLabels } from "./tabStripLabels";
import { moveTabOnDrop, type TabStripGroup, type TabStripMove } from "./tabStripModel";

/** dnd-kit's own live region speaks internal ids; the strip announces moves itself. */
const QUIET = () => undefined;
export const TAB_STRIP_DND_ACCESSIBILITY = {
  announcements: { onDragStart: QUIET, onDragMove: QUIET, onDragOver: QUIET, onDragEnd: QUIET, onDragCancel: QUIET },
  screenReaderInstructions: { draggable: "" },
};

const TAB_KEY_PREFIX = "tab:";

/**
 * Pointer drag (6px threshold, so clicks and middle-clicks stay clicks). Dropping on a tab takes its
 * slot, also across groups; dropping on a chip joins that group at its end. Keyboard moves live in
 * useTabStripNavigation (Cmd/Ctrl+Shift+arrows), so Space/Enter keep activating tabs.
 */
export function useTabStripDrag({ groups, labels, onMove, announce }: {
  groups: readonly TabStripGroup[];
  labels: TabStripLabels;
  onMove?: (move: TabStripMove) => void;
  announce: (message: string) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  const onDragStart = (event: DragStartEvent) => setDraggingKey(String(event.active.id));
  const onDragCancel = () => setDraggingKey(null);
  const onDragEnd = (event: DragEndEvent) => {
    setDraggingKey(null);
    const activeKey = String(event.active.id);
    if (!onMove || !event.over || !activeKey.startsWith(TAB_KEY_PREFIX)) return;
    const move = moveTabOnDrop(groups, activeKey.slice(TAB_KEY_PREFIX.length), String(event.over.id));
    if (!move) return;
    onMove(move);
    announce(movedAnnouncement(groups, move, labels));
  };

  return { sensors, draggingKey, handlers: { onDragStart, onDragEnd, onDragCancel } };
}
