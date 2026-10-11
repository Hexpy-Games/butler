import { useEffect } from "react";
import { useNavDropAutoScroll } from "@/butler-ds";
import { create } from "zustand";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { projectSpace } from "@/app/space/projection";
import { notifyStatus } from "@/app/notifications";
import { browserCall } from "./browserBridge";
import { attachElements, scrapElements, type PickedElement } from "./browserElements";
import { groupAt, type GroupTarget } from "../library/libraryDrop";
import { afterScrap, endDwell } from "../library/libraryDrop";

export interface ElementDragEvent { phase: string; tab: string; x: number; y: number; elements?: PickedElement[] }
type Target = { kind: "conversation"; session: string; instance?: string; title: string } | { kind: "library" } | GroupTarget;
export const useElementDrag = create<{ tab?: string; elements: PickedElement[]; target?: Target; x?: number; y?: number }>(() => ({ elements: [] }));
let connected = false;
/** A conversation under the pointer: a sidebar conversation row or the open conversation's composer. */
export function conversationAt(hit: Element | null): Extract<Target, { kind: "conversation" }> | undefined {
  const row = hit?.closest<HTMLElement>('[data-slot="nav-drop-target"][data-tree-item]');
  const record = row && projectSpace(useButlerStore.getState().navigation).get(row.dataset.treeItem!);
  if (record?.session && record.node.kind === "session") return { kind: "conversation", session: record.session.id, title: record.title, instance: row!.dataset.dragInstance };
  if (hit?.closest('[data-test-class="composer-card"]')) {
    const store = useButlerStore.getState();
    return { kind: "conversation", session: store.activeChatId, title: "" };
  }
}
function targetAt(x: number, y: number): Target | undefined {
  const hit = document.elementFromPoint(x, y);
  if (hit?.closest('[data-test-class="library-entry"]')) return { kind: "library" };
  const target = groupAt(hit, "scrap") ?? conversationAt(hit);
  if (target) return target;
  const view = useButlerStore.getState().view;
  if (view.kind === "library" && !view.section && !view.item && hit?.closest('[data-test-class="library-page"]') && !hit.closest('[data-group-tile], [data-group-chip]')) return { kind: "library" };
}
function move(x: number, y: number) { useElementDrag.setState({ target: targetAt(x, y), x, y }); }
async function drop() {
  const { tab, elements, target } = useElementDrag.getState();
  useElementDrag.setState({ tab: undefined, elements: [], target: undefined });
  endDwell();
  void browserCall("selection-command", { id: tab, op: "cancel-drag" });
  if (!target) return;
  try {
    if (target.kind === "library") afterScrap(await scrapElements(elements));
    else if (target.kind === "group") { await scrapElements(elements, target.group); notifyStatus(appCopy.library.added(elements.length, target.name)); }
    else { await attachElements(target.session, elements); notifyStatus(target.title ? appCopy.browser.attachedTo(target.title) : appCopy.browser.attachToChat); }
  } catch { notifyStatus(appCopy.browser.failed, { tone: "error" }); }
}
export function connectElementDrag() {
  if (connected || !window.butlerBrowser) return;
  connected = true;
  window.butlerBrowser.onElementDrag(event => {
    if (event.phase === "start") useElementDrag.setState({ tab: event.tab, elements: event.elements ?? [] });
    if (event.phase === "cancel") {
      useElementDrag.setState({ tab: undefined, elements: [], target: undefined }); endDwell(); return;
    }
    move(event.x, event.y);
    if (event.phase === "end") void drop();
  });
  document.addEventListener("pointermove", event => { if (useElementDrag.getState().tab) move(event.clientX, event.clientY); }, true);
  document.addEventListener("pointerup", event => {
    if (!useElementDrag.getState().tab) return;
    move(event.clientX, event.clientY); void drop();
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !useElementDrag.getState().tab) return;
    const tab = useElementDrag.getState().tab;
    useElementDrag.setState({ tab: undefined, elements: [], target: undefined });
    endDwell();
    void browserCall("selection-command", { id: tab, op: "cancel-drag" });
  }, true);
  window.butlerBrowser.onSelectionAction(async event => {
    try {
      if (event.op === "failed") { notifyStatus(appCopy.browser.failed, { tone: "error" }); return; }
      if (event.op === "copy-text") { notifyStatus(appCopy.conversation.messageActions.copied); return; }
      if (event.op === "save-image") { notifyStatus(appCopy.browser.imagesSaved(event.elements.length)); return; }
      if (event.op === "scrap") afterScrap(await scrapElements(event.elements));
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
