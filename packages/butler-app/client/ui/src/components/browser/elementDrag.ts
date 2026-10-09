import { useEffect } from "react";
import { useNavDropAutoScroll } from "@/butler-ds";
import { create } from "zustand";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { projectSpace } from "@/app/space/projection";
import { notifyStatus } from "@/app/notifications";
import { browserCall } from "./browserBridge";
import { attachElements, scrapElements, type PickedElement } from "./browserElements";

export interface ElementDragEvent { phase: string; tab: string; x: number; y: number; elements?: PickedElement[] }
type Target = { kind: "conversation"; session: string; instance?: string; title: string } | { kind: "library" };
export const useElementDrag = create<{ tab?: string; elements: PickedElement[]; target?: Target; x?: number; y?: number }>(() => ({ elements: [] }));
let connected = false;
function targetAt(x: number, y: number): Target | undefined {
  const hit = document.elementFromPoint(x, y);
  if (hit?.closest('[data-test-class="library-entry"]')) return { kind: "library" };
  const row = hit?.closest<HTMLElement>('[data-slot="nav-drop-target"][data-tree-item]');
  const record = row && projectSpace(useButlerStore.getState().navigation).get(row.dataset.treeItem!);
  if (record?.session && record.node.kind === "session") return { kind: "conversation", session: record.session.id, title: record.title, instance: row!.dataset.dragInstance };
  if (hit?.closest('[data-test-class="composer-card"]')) {
    const store = useButlerStore.getState();
    return { kind: "conversation", session: store.activeChatId, title: "" };
  }
}
function move(x: number, y: number) { useElementDrag.setState({ target: targetAt(x, y), x, y }); }
async function drop() {
  const { tab, elements, target } = useElementDrag.getState();
  useElementDrag.setState({ tab: undefined, elements: [], target: undefined });
  void browserCall("selection-command", { id: tab, op: "cancel-drag" });
  if (!target) return;
  try {
    if (target.kind === "library") { await scrapElements(elements); notifyStatus(appCopy.browser.scrapsSaved(elements.length)); }
    else { await attachElements(target.session, elements); notifyStatus(target.title ? appCopy.browser.attachedTo(target.title) : appCopy.browser.attachToChat); }
  } catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
}
export function connectElementDrag() {
  if (connected || !window.butlerBrowser) return;
  connected = true;
  window.butlerBrowser.onElementDrag(event => {
    if (event.phase === "start") useElementDrag.setState({ tab: event.tab, elements: event.elements ?? [] });
    move(event.x, event.y);
    if (event.phase === "end") void drop();
  });
  document.addEventListener("pointermove", event => { if (useElementDrag.getState().tab) move(event.clientX, event.clientY); }, true);
  document.addEventListener("pointerup", () => { if (useElementDrag.getState().tab) void drop(); }, true);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !useElementDrag.getState().tab) return;
    const tab = useElementDrag.getState().tab;
    useElementDrag.setState({ tab: undefined, elements: [], target: undefined });
    void browserCall("selection-command", { id: tab, op: "cancel-drag" });
  }, true);
  window.butlerBrowser.onSelectionAction(async event => {
    try {
      if (event.op === "scrap") { await scrapElements(event.elements); notifyStatus(appCopy.browser.scrapsSaved(event.elements.length)); }
      else await attachElements(useButlerStore.getState().activeChatId, event.elements);
    } catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
  });
}

/** The existing sidebar edge scroller is active only during an element drag. */
export function useElementDragAutoScroll() {
  const drag = useElementDrag();
  const scroll = useNavDropAutoScroll();
  useEffect(() => {
    const hit = drag.tab && drag.x !== undefined && drag.y !== undefined ? document.elementFromPoint(drag.x, drag.y) : null;
    const scroller = hit?.closest<HTMLElement>('[data-test-class="sidebar-scroll"]');
    if (scroller) scroll.update(drag.y!, scroller); else scroll.stop();
  }, [drag.tab, drag.x, drag.y, scroll.update, scroll.stop]);
  return scroll.edge;
}
