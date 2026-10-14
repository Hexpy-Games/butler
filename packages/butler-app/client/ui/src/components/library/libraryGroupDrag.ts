import type { PointerEvent as ReactPointerEvent } from "react";
import { notifyStatus } from "@/app/notifications";
import { suppressDragClick } from "./libraryDragClick";
import { appCopy } from "@/app/copy";
import { moveGroup, type LibraryGroup } from "./libraryApi";
import { useLibraryNames } from "./libraryNav";

/** Tiles and chips share one persisted, per-kind order. */
export function startGroupDrag(event: ReactPointerEvent, group: LibraryGroup) {
  if (event.button !== 0 || (event.target as Element).closest('[aria-haspopup]')) return;
  const start = { x: event.clientX, y: event.clientY };
  let dragging = false, target: string | undefined;
  const move = (e: PointerEvent) => {
    if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
    dragging = true;
    const node = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-group-tile], [data-group-chip]");
    const id = node?.dataset.groupTile || node?.dataset.groupChip;
    target = id && id !== group.id && useLibraryNames.getState().groups[id]?.kind === group.kind ? id : undefined;
  };
  const stop = (drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    if (!dragging) return;
    if (drop) suppressDragClick();
    const position = target ? useLibraryNames.getState().groups[target]?.position : undefined;
    if (drop && position !== undefined) void moveGroup(group.id, position).catch(() => notifyStatus(appCopy.library.failed, { tone: "error" }));
  };
  const up = () => stop(true), cancel = () => stop(false);
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") stop(false); };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}
