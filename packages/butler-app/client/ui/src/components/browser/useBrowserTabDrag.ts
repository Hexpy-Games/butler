import { useEffect, useRef, type PointerEvent } from "react";
import { useNavDropAutoScroll } from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { projectSpace } from "@/app/space/projection";
import { notifyStatus } from "@/app/notifications";
import { appCopy } from "@/app/copy";
import { browserCall, type BrowserTab } from "./browserBridge";
import { endBrowserTabDrag, useBrowserTabDrag } from "./browserTabDrag";

type Start = { tab: BrowserTab; x: number; y: number; strip: HTMLElement };

/** Extends the strip's own reorder gesture to conversation rows, without native page drag data. */
export function useBrowserTabDragHandler(tabs: BrowserTab[]) {
  const start = useRef<Start | undefined>(undefined);
  const scroll = useNavDropAutoScroll();
  useEffect(() => { useBrowserTabDrag.setState({ edge: scroll.edge }); }, [scroll.edge]);
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const source = start.current;
      if (!source || Math.hypot(event.clientX - source.x, event.clientY - source.y) < 6) return;
      const box = source.strip.getBoundingClientRect();
      const outside = event.clientY < box.top || event.clientY > box.bottom;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const row = hit?.closest<HTMLElement>('[data-slot="nav-drop-target"][data-tree-item]');
      const record = row && projectSpace(useButlerStore.getState().navigation).get(row.dataset.treeItem!);
      const target = record?.session && record.node.kind === "session" && source.tab.owner !== `conversation:${record.session.id}`
        ? { session: record.session.id, instance: row!.dataset.dragInstance!, title: record.title } : undefined;
      useBrowserTabDrag.setState({ tabId: source.tab.id, owner: source.tab.owner, outside, target });
      const scroller = hit?.closest<HTMLElement>('[data-test-class="sidebar-scroll"]');
      if (scroller) scroll.update(event.clientY, scroller); else scroll.stop();
    };
    const finish = (event: globalThis.PointerEvent) => {
      if (!start.current) return;
      const drag = useBrowserTabDrag.getState();
      start.current = undefined; scroll.stop();
      if (event.type === "pointerup" && drag.outside && drag.tabId && drag.target) {
        const title = drag.target.title;
        void browserCall("move", { tabId: drag.tabId, toGroupId: `conversation:${drag.target.session}`, index: 0 })
          .then((id) => { if (id === drag.tabId) notifyStatus(appCopy.browser.movedTo(title)); });
      }
      // Keep the outside fact through dnd-kit's pointerup, so closestCenter cannot reorder on a sidebar drop.
      queueMicrotask(() => { endBrowserTabDrag(); useBrowserTabDrag.setState({ outside: drag.outside }); });
    };
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") { start.current = undefined; scroll.stop(); endBrowserTabDrag(); } };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", finish, true);
    document.addEventListener("pointercancel", finish, true);
    document.addEventListener("keydown", cancel, true);
    return () => {
      document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", finish, true); document.removeEventListener("keydown", cancel, true);
      if (start.current) { start.current = undefined; scroll.stop(); endBrowserTabDrag(); }
    };
  }, [scroll.update, scroll.stop]);
  return (event: PointerEvent<HTMLDivElement>) => {
    endBrowserTabDrag();
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const strip = event.currentTarget;
    const node = (event.target as Element).closest('[role="tab"]');
    const index = [...strip.querySelectorAll('[role="tab"]')].indexOf(node!);
    if (tabs[index]) start.current = { tab: tabs[index], x: event.clientX, y: event.clientY, strip };
  };
}
