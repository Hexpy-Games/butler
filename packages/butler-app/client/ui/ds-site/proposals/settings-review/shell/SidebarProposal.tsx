import { useMemo, type ReactNode } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { spaceActivity } from "@/app/space/activity";
import { useOrganization } from "@/app/space/organization";
import { projectSpace, spaceChildren } from "@/app/space/projection";
import { useButlerStore } from "@/app/store";
import { CollapsibleList, SidebarShell, SidebarTrafficSpace } from "@/butler-ds";
import { SpaceBrand } from "@/components/space/SpaceBrand";
import { SpaceBrowseHeader } from "@/components/space/SpaceBrowseHeader";
import { SpaceDropScope } from "@/components/space/SpaceDropScope";
import { SpaceHeader } from "@/components/space/SpaceHeader";
import { SpaceRow } from "@/components/space/SpaceRow";

// PROPOSAL COPY of components/space/SpaceSidebar.tsx: the same SidebarShell, header, browse
// header and rows. Changed: `footer` is passed in (the update indicator variants). Dropped for
// the mock only: drag auto-scroll, paging and dialogs (unchanged in the product).

export function SidebarProposal({ footer }: { footer: ReactNode }) {
  const locale = useAppLocale();
  const navigation = useButlerStore((s) => s.navigation);
  const leftOpen = useButlerStore((s) => s.leftOpen);
  const tab = useOrganization((s) => s.tab);
  const rows = useMemo(() => projectSpace(navigation), [navigation, locale]);
  const roots = tab === "all"
    ? spaceChildren(rows, null)
    : [...rows.values()].filter((r) => r.session && (tab === "recent" || spaceActivity(r.session)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.node.key.localeCompare(b.node.key));
  return (
    <SidebarShell
      collapsed={!leftOpen}
      titlebar={window.butlerApp ? <SidebarTrafficSpace /> : <SpaceBrand />}
      ariaLabel={appCopy.space.navigation}
      scrollHeader={<SpaceHeader rows={rows} />}
      stickyHeader={<SpaceBrowseHeader />}
      footer={footer}
    >
      <SpaceDropScope enabled={false} ariaLabel={appCopy.space.conversationList}>
        <CollapsibleList scope={tab}>
          {roots.slice(0, 30).map((row) => (
            <SpaceRow key={`${tab}:${row.node.key}`} rowKey={row.node.key} flat={tab !== "all"} />
          ))}
        </CollapsibleList>
      </SpaceDropScope>
    </SidebarShell>
  );
}
