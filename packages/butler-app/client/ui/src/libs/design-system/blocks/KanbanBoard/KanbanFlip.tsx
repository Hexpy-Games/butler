import { Component, type ReactNode } from "react";
import { animateMotion } from "../../lib/motion";
import { laneCardIds, type KanbanRegistry } from "./kanbanMeasure";

interface KanbanFlipProps {
  registry: KanbanRegistry;
  activeId: string | null;
  mode: "pointer" | "keyboard" | null;
  /** Lane holding the drop slot; it closes on drop, so its cards glide too. */
  anchorLaneId: string | null;
  children: ReactNode;
}

interface Place {
  left: number;
  top: number;
  laneId: string;
  index: number;
  /** The lane's own offset; a card that stays in its lane glides relative to it. */
  laneLeft: number;
  laneTop: number;
}

type Snapshot = { places: Map<string, Place>; slotLane: string | null; skipId: string | null } | null;

function places(registry: KanbanRegistry): Map<string, Place> {
  const found = new Map<string, Place>();
  for (const [laneId, lane] of registry.lanes) {
    const box = lane.element.getBoundingClientRect();
    laneCardIds(registry, laneId, null).forEach((id, index) => {
      const rect = registry.cards.get(id)!.element.getBoundingClientRect();
      found.set(id, { left: rect.left, top: rect.top, laneId, index, laneLeft: box.left, laneTop: box.top });
    });
  }
  return found;
}

/**
 * Cards glide to their new places (FLIP) when a commit moves them: a drop (the dragged card, its
 * new and old neighbors, and the slot closing), a rejected drop snapping back, or new order from the
 * product. A pointer-dropped card is left to the overlay's settle. Mid-drag commits are skipped:
 * slots animate themselves. Reduced motion places cards at once.
 */
export class KanbanFlip extends Component<KanbanFlipProps> {
  getSnapshotBeforeUpdate(previous: KanbanFlipProps): Snapshot {
    if (this.props.activeId) return null;
    const ended = previous.activeId !== null;
    return { places: places(this.props.registry), slotLane: ended ? previous.anchorLaneId : null,
      skipId: ended && previous.mode === "pointer" ? previous.activeId : null };
  }

  componentDidUpdate(_previous: KanbanFlipProps, _state: unknown, snapshot: Snapshot) {
    if (!snapshot) return;
    const now = places(this.props.registry);
    // Only lanes whose order changed (or that held the slot) glide; cards elsewhere that merely
    // shift with the page move with their lanes.
    const lanes = new Set(snapshot.slotLane ? [snapshot.slotLane] : []);
    for (const [id, place] of now) {
      const before = snapshot.places.get(id);
      if (before && (before.laneId !== place.laneId || before.index !== place.index)) lanes.add(before.laneId).add(place.laneId);
    }
    for (const [id, place] of now) {
      const before = snapshot.places.get(id);
      if (!before || id === snapshot.skipId || !lanes.has(place.laneId)) continue;
      const own = before.laneId === place.laneId;
      const dx = before.left - place.left - (own ? before.laneLeft - place.laneLeft : 0);
      const dy = before.top - place.top - (own ? before.laneTop - place.laneTop : 0);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      animateMotion(this.props.registry.cards.get(id)!.element, [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: "none" },
      ], { duration: "base", easing: "emphasized" });
    }
  }

  render() {
    return this.props.children;
  }
}
