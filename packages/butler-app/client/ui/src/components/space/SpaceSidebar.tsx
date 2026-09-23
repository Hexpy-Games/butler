import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SidebarShell,
  SidebarTrafficSpace,
  Stack,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
import { useSpaceDrag } from "@/app/space/drag";
import { projectSpace, spaceChildren } from "@/app/space/projection";
import { spaceActivity } from "@/app/space/activity";
import { SpaceHeader } from "./SpaceHeader";
import { SpaceBrand } from "./SpaceBrand";
import { SpaceBrowseHeader } from "./SpaceBrowseHeader";
import { SpaceRow } from "./SpaceRow";
import { SpaceDialogs } from "./SpaceDialogs";
import { SpaceRootDrop } from "./SpaceRootDrop";
import { SidebarSettingsItem } from "../layout/SidebarSettingsItem";
import { SidebarSessionLoadMore } from "../layout/SidebarSessionLoadMore";
import styles from "./SpaceSidebar.module.css";

export function SpaceSidebar() {
  const locale = useAppLocale();
  const navigation = useButlerStore((s) => s.navigation);
  const leftOpen = useButlerStore((s) => s.leftOpen);
  const tab = useOrganization((s) => s.tab);
  const revealPath = useOrganization((s) => s.revealPath);
  const reveal = useOrganization((s) => s.reveal);
  const activeChatId = useButlerStore((s) => s.activeChatId);
  const previousNodes = useRef(navigation.space.nodes);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragSource = useSpaceDrag((s) => s.source);
  useEffect(() => {
    const active = navigation.space.nodes.find((node) => node.entityId === activeChatId);
    const before = previousNodes.current.find((node) => node.entityId === activeChatId);
    if (active && (!before || active.parentKey !== before.parentKey)) reveal(active.key, false);
    previousNodes.current = navigation.space.nodes;
  }, [activeChatId, navigation.space.nodes, reveal]);
  const rows = useMemo(() => projectSpace(navigation), [navigation, locale]);
  const [visibleCount, setVisibleCount] = useState(30);
  useEffect(() => {
    if (!dragSource || tab !== "all") return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    let lastPage = 0;
    const track = (event: DragEvent) => { pointer = { x: event.clientX, y: event.clientY }; };
    const clear = () => { pointer = null; };
    const step = (now: number) => {
      if (pointer) {
        const rect = scroll.getBoundingClientRect();
        const sticky = scroll.querySelector<HTMLElement>('[data-test-class="sidebar-sticky-header"]');
        const top = Math.max(rect.top, sticky?.getBoundingClientRect().bottom ?? rect.top);
        if (pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom) {
          const edge = 64;
          const up = Math.max(0, Math.min(1, (top + edge - pointer.y) / edge));
          const down = Math.max(0, Math.min(1, (pointer.y - (rect.bottom - edge)) / edge));
          scroll.scrollTop += Math.round((down - up) * 18);
          if (down > 0 && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 80 && now - lastPage > 150) {
            setVisibleCount((count) => Math.min(count + 30, navigation.space.nodes.length));
            lastPage = now;
          }
        }
      }
      frame = requestAnimationFrame(step);
    };
    document.addEventListener("dragover", track, true);
    document.addEventListener("drop", clear, true);
    document.addEventListener("dragend", clear, true);
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("dragover", track, true);
      document.removeEventListener("drop", clear, true);
      document.removeEventListener("dragend", clear, true);
    };
  }, [dragSource, tab, navigation.space.nodes.length]);
  const roots =
    tab === "all"
      ? spaceChildren(rows, null)
      : [...rows.values()]
          .filter(
            (r) => r.session && (tab === "recent" || spaceActivity(r.session)),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.node.key.localeCompare(b.node.key));
  return (
    <>
      <SidebarShell
        collapsed={!leftOpen}
        titlebar={
          window.butlerApp ? (
            <SidebarTrafficSpace />
          ) : <SpaceBrand />
        }
        className={styles.sidebar}
        scrollRef={scrollRef}
        ariaLabel={appCopy.space.navigation}
        scrollHeader={<SpaceHeader rows={rows} />}
        stickyHeader={<SpaceBrowseHeader />}
        footer={<SidebarSettingsItem />}
      >
        <Stack gap="1" as="nav" aria-label={appCopy.space.conversationList}>
          {roots
            .slice(
              0,
              Math.max(
                visibleCount,
                roots.findIndex((row) => revealPath.includes(row.node.key)) + 1,
              ),
            )
            .map((row) => (
              <SpaceRow
                key={`${tab}:${row.node.key}`}
                rowKey={row.node.key}
                flat={tab !== "all"}
              />
            ))}
          {roots.length > visibleCount && (
            <SidebarSessionLoadMore
              remainingCount={roots.length - visibleCount}
              onClick={() => setVisibleCount((n) => n + 30)}
            />
          )}
          {tab === "all" && <SpaceRootDrop rows={rows} />}
        </Stack>
      </SidebarShell>
      <SpaceDialogs rows={rows} />
    </>
  );
}
