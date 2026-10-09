import { useEffect, useMemo, type DragEvent, type ReactNode } from "react";
import { NavDropScope, createDropZoneTracker, measureDropBox, type DropZoneCandidate } from "@/butler-ds";
import { useElementDrag, useElementDragAutoScroll } from "../browser/elementDrag";
import { useBrowserTabDrag } from "../browser/browserTabDrag";
import { canDrop, useSpaceDrag, type DropPosition } from "@/app/space/drag";
import { requestSpaceMove } from "@/app/space/move";
import { useOrganization } from "@/app/space/organization";
import { projectSpace, spaceChildren, type SpaceRowData } from "@/app/space/projection";
import { useButlerStore } from "@/app/store";

type Candidate = DropZoneCandidate<string> & { item: HTMLElement; header: HTMLElement };

/**
 * The Space tree's drop handling. Rows are hit-tested on their layout boxes
 * (DS dropZones), so the slot the rows open never moves the zones.
 */
export function SpaceDropScope({ enabled, ariaLabel, children }: { enabled: boolean; ariaLabel: string; children: ReactNode }) {
  const elementEdge = useElementDragAutoScroll();
  const elementDragging = useElementDrag(s => Boolean(s.tab));
  const tabDragging = useBrowserTabDrag((s) => Boolean(s.tabId));
  const tabEdge = useBrowserTabDrag((s) => s.edge);
  const dragging = useSpaceDrag((s) => s.source !== null);
  const tracker = useMemo(() => createDropZoneTracker<string>(), []);
  useEffect(() => {
    if (!dragging) tracker.reset();
  }, [dragging, tracker]);

  function candidates(scope: HTMLElement, rows: Map<string, SpaceRowData>, source: string): Candidate[] {
    const collapsed = useOrganization.getState().collapsed;
    return [...scope.querySelectorAll<HTMLElement>('[data-slot="nav-drop-target"][data-tree-item]')].flatMap((item) => {
      const key = item.dataset.treeItem!;
      const row = rows.get(key);
      const header = item.querySelector<HTMLElement>('[data-test-class~="tree-row"]');
      if (!row || !header) return [];
      const folder = row.node.kind !== "session";
      const expanded = folder && !collapsed.includes(key) && spaceChildren(rows, key).length > 0;
      return [{
        key, item, header, ...measureDropBox(header, scope),
        combine: canDrop(rows, source, key, folder ? "inside" : "group"),
        after: !expanded,
      }];
    });
  }

  function over(event: DragEvent<HTMLElement>) {
    const drag = useSpaceDrag.getState();
    if (!drag.source || !enabled) return;
    event.preventDefault();
    const rows = projectSpace(useButlerStore.getState().navigation);
    const list = candidates(event.currentTarget, rows, drag.source);
    const hit = tracker.update(event.clientY, list, event.timeStamp);
    const candidate = hit ? list.find((row) => row.key === hit.key) : undefined;
    const row = candidate ? rows.get(candidate.key) : undefined;
    const position: DropPosition | undefined = !hit || !row ? undefined
      : hit.zone === "combine" ? (row.node.kind === "session" ? "group" : "inside") : hit.zone;
    const possible = candidate && position ? canDrop(rows, drag.source, candidate.key, position) : false;
    event.dataTransfer.dropEffect = possible ? "move" : "none";
    if (!possible || !candidate || !position) {
      if (drag.target) drag.over(null);
      return;
    }
    // The header's layout offset inside its item (a folder's children sit below it).
    const top = measureDropBox(candidate.header, candidate.item).top - candidate.item.getBoundingClientRect().top;
    const next = {
      key: candidate.key, instance: candidate.item.dataset.dragInstance ?? "", position,
      indicator: { top, height: candidate.height },
    };
    const current = drag.target;
    if (current?.key === next.key && current.instance === next.instance && current.position === next.position
      && current.indicator?.top === next.indicator.top && current.indicator.height === next.indicator.height) return;
    drag.over(next);
  }

  function drop(event: DragEvent<HTMLElement>) {
    const { source, target, end } = useSpaceDrag.getState();
    if (!source) return;
    event.preventDefault();
    const rows = projectSpace(useButlerStore.getState().navigation);
    if (enabled && target?.key) {
      if (target.position === "group") {
        useOrganization.getState().setDialog({ kind: "group", sourceKey: source, targetKey: target.key });
      } else {
        requestSpaceMove(rows, source, target.key, target.position);
      }
    }
    tracker.reset();
    end();
  }

  return (
    <NavDropScope
      as="nav"
      aria-label={ariaLabel}
      active={elementDragging || tabDragging || dragging && enabled}
      payload={elementDragging || tabDragging ? "outside" : "rows"} autoScroll={elementDragging ? elementEdge : tabDragging ? tabEdge : undefined}
      onDragOver={over}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        tracker.reset();
        useSpaceDrag.getState().over(null);
      }}
      onDrop={drop}
    >
      {children}
    </NavDropScope>
  );
}
