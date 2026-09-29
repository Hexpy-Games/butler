import type { ReactNode } from "react";
import { NavRow } from "../../../../blocks/NavRow";
import { NavSectionHeading } from "../../../../blocks/NavSection";
import { SidebarBrand, SidebarNav, SidebarShell } from "../../../../blocks/SidebarShell";
import { Box } from "../../../Box";
import { ButtonContainer } from "../../../ButtonContainer";
import { IconButton } from "../../../IconButton";
import { IconSlot } from "../../../IconSlot";
import { Activity, Clock3, GeneralChat, ListFilter, MessageSquare, MoreHorizontal, PencilLine, Plus, Search, Settings } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Tabs, TabsList, TabsTrigger } from "../../../Tabs";
import { Typo } from "../../../Typo";
import type { LayersCopy } from "./layersCopy";

const glyph = (icon: ReactNode) => <IconSlot size="sidebar">{icon}</IconSlot>;

/** The sidebar as the product builds it (SpaceSidebar): brand, entry actions, favorites, sticky browse tabs, the space tree, settings. */
export function Sidebar({ copy }: { copy: LayersCopy }) {
  return (
    <SidebarShell
      ariaLabel={copy.sidebar}
      titlebar={
        <SidebarBrand>
          <Typo.AppTitle>{copy.app}</Typo.AppTitle>
        </SidebarBrand>
      }
      scrollHeader={
        <Stack gap="2xl">
          <SidebarNav>
            <NavRow icon={<PencilLine />} label={copy.newChat} />
            <NavRow icon={<Search />} label={copy.search} />
          </SidebarNav>
          <Stack gap="sm">
            <NavSectionHeading title={copy.favorites} />
            <Box paddingX="sm">
              <Typo.Caption as="p" tone="secondary">
                {copy.favoritesHint}
              </Typo.Caption>
            </Box>
          </Stack>
        </Stack>
      }
      stickyHeader={
        <Stack gap="sm">
          <Stack gap="md">
            <Tabs value="all">
              <TabsList stretch aria-label={copy.views}>
                <TabsTrigger value="all">
                  <ListFilter />
                  {copy.all}
                </TabsTrigger>
                <TabsTrigger value="recent">
                  <Clock3 />
                  {copy.recent}
                </TabsTrigger>
                <TabsTrigger value="running">
                  <Activity />
                  {copy.running}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <NavRow icon={glyph(<GeneralChat />)} label={copy.general} />
          </Stack>
          <NavSectionHeading
            title={copy.space}
            actions={
              <ButtonContainer size="icon-sm">
                <IconButton label={copy.createGroup}>
                  <Plus />
                </IconButton>
                <IconButton label={copy.menu}>
                  <MoreHorizontal />
                </IconButton>
              </ButtonContainer>
            }
          />
        </Stack>
      }
      footer={<NavRow icon={<Settings />} label={copy.settings} />}
    >
      {copy.sessions.map((title, k) => (
        <NavRow active={k === 0} icon={glyph(<MessageSquare />)} key={title} label={title} />
      ))}
    </SidebarShell>
  );
}
