import { useEffect, useRef, type PointerEvent } from "react";
import { useNavDropAutoScroll } from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { projectSpace } from "@/app/space/projection";
import { notifyStatus } from "@/app/notifications";
import { appCopy } from "@/app/copy";
import { browserCall, type BrowserTab } from "./browserBridge";
import { endBrowserTabDrag, useBrowserTabDrag } from "./browserTabDrag";

type Start = { tab: BrowserTab; x: number; y: number; strip: HTMLElement };

/** What lies under the pointer: whether it left the strip's row, and the conversation row it is over. */
function locate(source: Start, x: number, y: number) {
  const box = source.strip.getBoundingClientRect();
  const outside = y < box.top || y > box.bottom;
  const hit = document.elementFromPoint(x, y);
  const row = hit?.closest<HTMLElement>('[data-slot="nav-drop-target"][data-tree-item]');
  const record = row && projectSpace(useButlerStore.getState().navigation).get(row.dataset.treeItem!);
  const target = record?.session && record.node.kind === "session" && source.tab.owner !== `conversation:${record.session.id}`
    ? { session: record.session.id, instance: row!.dataset.dragInstance!, title: record.title } : undefined;
  return { outside, target, hit };
}

/** Extends the strip's own reorder gesture to conversation rows, without native page drag data. */
export function useBrowserTabDragHandler(tabs: BrowserTab[]) {
  const start = useRef<Start | undefined>(undefined);
  const scroll = useNavDropAutoScroll();
  useEffect(() => { useBrowserTabDrag.setState({ edge: scroll.edge }); }, [scroll.edge]);
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const source = start.current;
      if (!source || Math.hypot(event.clientX - source.x, event.clientY - source.y) < 6) return;
      const { outside, target, hit } = locate(source, event.clientX, event.clientY);
      useBrowserTabDrag.setState({ tabId: source.tab.id, owner: source.tab.owner, outside, target,
        x: event.clientX, y: event.clientY, title: source.tab.title, favicon: source.tab.favicon });
      const scroller = hit?.closest<HTMLElement>('[data-test-class="sidebar-scroll"]');
      if (scroller) scroll.update(event.clientY, scroller); else scroll.stop();
    };
    const finish = (event: globalThis.PointerEvent) => {
      const source = start.current;
      if (!source) return;
      const last = useBrowserTabDrag.getState();
      // A drop lands where the pointer is released, not where the last pointer move left the drag.
      const drag = last.tabId && event.type === "pointerup" ? { ...last, ...locate(source, event.clientX, event.clientY) } : last;
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
    // A folded group keeps its tabs mounted but inert; `tabs` lists only the tabs the strip shows.
    const shown = [...strip.querySelectorAll('[role="tab"]')].filter((tab) => !tab.closest("[inert]"));
    const index = shown.indexOf(node!);
    if (tabs[index]) start.current = { tab: tabs[index], x: event.clientX, y: event.clientY, strip };
  };
}
