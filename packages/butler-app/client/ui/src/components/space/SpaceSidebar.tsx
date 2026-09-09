import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useMemo, useState } from "react";
import {
  SidebarShell,
  SidebarTrafficSpace,
  Stack,
} from "@/butler-ds";
import { useButlerStore } from "@/app/store";
import { useOrganization } from "@/app/space/organization";
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
  const rows = useMemo(() => projectSpace(navigation), [navigation, locale]);
  const [visibleCount, setVisibleCount] = useState(30);
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
