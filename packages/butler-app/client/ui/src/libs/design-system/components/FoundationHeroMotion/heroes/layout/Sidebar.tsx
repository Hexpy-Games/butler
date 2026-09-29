import type { ReactNode } from "react";
import { useCallback } from "react";
import { CollapsibleNavGroup } from "../../../../blocks/CollapsibleNavGroup";
import { NavRow } from "../../../../blocks/NavRow";
import { NavSectionHeading } from "../../../../blocks/NavSection";
import { SidebarBrand, SidebarNav, SidebarShell } from "../../../../blocks/SidebarShell";
import { Box } from "../../../Box";
import { ButtonContainer } from "../../../ButtonContainer";
import { IconButton } from "../../../IconButton";
import { IconSlot } from "../../../IconSlot";
import { Activity, Briefcase, ChevronDown, Clock3, LayoutDashboard, ListFilter, MoreHorizontal, Notebook, PencilLine, Plus, Search, Settings } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Tabs, TabsList, TabsTrigger } from "../../../Tabs";
import { Typo } from "../../../Typo";
import type { LayoutCopy } from "./layoutCopy";

const glyph = (icon: ReactNode) => <IconSlot size="sidebar">{icon}</IconSlot>;

/** The space sidebar as the app draws it (SpaceSidebar): brand, entry rows, favourites, the browse tabs, the space tree, settings. */
export function Sidebar({ copy, touch }: { copy: LayoutCopy; touch: boolean }) {
  // In the touch drawer the list is short of room, so it is scrolled up to the browse tabs, as a person browsing it would leave it.
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    const head = node?.querySelector<HTMLElement>("[data-slot=\"sidebar-scroll-header\"]");
    if (touch && node && head) node.scrollTop = head.offsetHeight;
  }, [touch]);
  return (
    <SidebarShell
      density={touch ? "touch" : "comfortable"}
      scrollRef={scrollRef}
      titlebar={<SidebarBrand><Typo.AppTitle>{copy.app}</Typo.AppTitle></SidebarBrand>}
      scrollHeader={
        <Stack gap="2xl">
          <SidebarNav>
            <NavRow icon={<PencilLine />} label={copy.newChat} />
            <NavRow icon={<Search />} label={copy.search} />
          </SidebarNav>
          <Stack gap="sm">
            <NavSectionHeading title={copy.favorites} />
            <Box paddingX="sm"><Typo.Caption as="p" tone="secondary">{copy.favoritesHint}</Typo.Caption></Box>
          </Stack>
        </Stack>
      }
      stickyHeader={
        <Stack gap="sm" compactGap="lg">
          {/* The General row shows only once a general chat exists (SpaceBrowseHeader); this space has none. */}
          <Stack gap="md">
            <Tabs value="all">
              <TabsList stretch>
                <TabsTrigger value="all"><ListFilter />{copy.all}</TabsTrigger>
                <TabsTrigger value="recent"><Clock3 />{copy.recent}</TabsTrigger>
                <TabsTrigger value="running"><Activity />{copy.running}</TabsTrigger>
              </TabsList>
            </Tabs>
          </Stack>
          <NavSectionHeading
            title={copy.space}
            actions={<ButtonContainer size="icon-sm"><IconButton label={copy.space}><Plus /></IconButton><IconButton label={copy.more}><MoreHorizontal /></IconButton></ButtonContainer>}
          />
        </Stack>
      }
      footer={<NavRow icon={<Settings />} label={copy.settings} />}
    >
      <CollapsibleNavGroup
        actions={<ButtonContainer size="icon-sm" wrap={false}><IconButton label={copy.project}><LayoutDashboard /></IconButton><IconButton label={copy.project}><ChevronDown /></IconButton></ButtonContainer>}
        expanded
        icon={glyph(<Briefcase />)}
        indented
        label={copy.project}
        onToggle={() => undefined}
        stickyDepth={0}
      >
        {copy.sessions.map((label, k) => k === copy.active
          ? <NavRow actions={<IconButton label={copy.more}><MoreHorizontal /></IconButton>} actionsVisibility="visible" active icon={glyph(<Notebook />)} key={label} label={label} />
          : <NavRow icon={glyph(<Notebook />)} key={label} label={label} />)}
      </CollapsibleNavGroup>
    </SidebarShell>
  );
}
