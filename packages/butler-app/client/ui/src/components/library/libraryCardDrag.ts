import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { attachLibrary, type LibraryItem } from "../browser/libraryStore";
import { conversationAt } from "../browser/elementDrag";
import { fileItems } from "./libraryActions";
import { groupAt, type GroupTarget } from "./libraryDrop";

type ConversationTarget = NonNullable<ReturnType<typeof conversationAt>>;
/** Cards being dragged (the App draws the drag): onto a group tile or chip of their kind, or onto a conversation. */
export const useCardDrag = create<{ items: LibraryItem[]; x?: number; y?: number; target?: GroupTarget | ConversationTarget }>(() => ({ items: [] }));

const IGNORE = 'button[aria-haspopup], [role="checkbox"], input, [data-slot="dropdown-menu-trigger"]';

/** Pointer down on a card: a drag starts after 5px of travel; a plain click stays a click. */
export function startCardDrag(event: ReactPointerEvent, items: () => LibraryItem[]) {
  if (event.button !== 0 || (event.target as Element).closest(IGNORE)) return;
  const start = { x: event.clientX, y: event.clientY };
  let dragging = false;
  const kind = () => useCardDrag.getState().items[0]?.kind ?? "scrap";
  const move = (e: PointerEvent) => {
    if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
    if (!dragging) { dragging = true; useCardDrag.setState({ items: items() }); }
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    useCardDrag.setState({ x: e.clientX, y: e.clientY, target: groupAt(hit, kind()) ?? conversationAt(hit) });
  };
  const stop = (drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("keydown", key, true);
    const { items: dragged, target } = useCardDrag.getState();
    useCardDrag.setState({ items: [], x: undefined, y: undefined, target: undefined });
    if (!dragging) return;
    // The click that ends a drag must not open the card.
    window.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); }, { capture: true, once: true });
    if (drop && target) void dropOn(target, dragged);
  };
  const up = () => stop(true);
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") stop(false); };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("keydown", key, true);
}

async function dropOn(target: GroupTarget | ConversationTarget, items: LibraryItem[]) {
  if (target.kind === "group") { await fileItems(items, target.group); return; }
  try { for (const item of items) await attachLibrary(target.session, item); }
  catch { notifyStatus(appCopy.library.failed, { tone: "error" }); }
}
