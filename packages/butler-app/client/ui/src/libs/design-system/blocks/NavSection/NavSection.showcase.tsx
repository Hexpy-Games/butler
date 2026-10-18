import type { ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Box } from "../../components/Box";
import { ButtonContainer } from "../../components/ButtonContainer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/DropdownMenu";
import { IconButton } from "../../components/IconButton";
import { IconSlot } from "../../components/IconSlot";
import { Folder, FolderPlus, PencilLine, Pin } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { NavRow } from "../NavRow";
import { SidebarShell } from "../SidebarShell";
import { NavSection, NavSectionHeading } from "./index";

export const meta: ShowcaseMeta = {
  title: "NavSection",
  category: "Navigation",
  tags: ["sidebar", "section", "heading", "navigation"],
  status: "stable",
};

const labels = {
  "en-US": {
    projects: "Projects", newProject: "New project", space: "Space", createGroup: "New group", newChat: "New chat",
    spaceMenu: "Space menu", sidebar: "Sidebar",
    favorites: "Favorites", favoritesHint: "Star a conversation or folder to keep it here.",
    items: ["butler", "butler-site", "research-notes"],
  },
  "ko-KR": {
    projects: "프로젝트", newProject: "새 프로젝트", space: "스페이스", createGroup: "새 그룹", newChat: "새 대화",
    spaceMenu: "스페이스 메뉴", sidebar: "사이드바",
    favorites: "즐겨찾기", favoritesHint: "대화나 폴더에 별표를 달면 여기에 모입니다.",
    items: ["butler", "butler-site", "research-notes"],
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Sections live in the app's SidebarShell, which sizes their heading actions. */
function Sidebar({ context, children }: { context: ShowcaseRenderContext; children: ReactNode }) {
  return <SidebarShell ariaLabel={text(context).sidebar} scrollFade={false}>{children}</SidebarShell>;
}

/** SpaceBrowseHeader: new chat, then the space menu, in one icon cluster. */
function SpaceActions({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <ButtonContainer size="icon-sm">
      <IconButton label={copy.newChat}><IconSlot size="sm"><PencilLine /></IconSlot></IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={copy.spaceMenu}><IconSlot size="sm"><FolderPlus /></IconSlot></IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8}>
          <DropdownMenuItem>{copy.createGroup}</DropdownMenuItem>
          <DropdownMenuItem>{copy.newProject}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonContainer>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Sidebar section (SidebarSection)",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Sidebar context={context}>
        <NavSection title={text(context).projects}
          actions={<ButtonContainer size="icon-sm"><IconButton label={text(context).newProject}><FolderPlus size="md" /></IconButton></ButtonContainer>}>
          {text(context).items.map((item, index) => (
            <NavRow active={index === 0} icon={<Folder size="md" />} key={item} label={item} onClick={() => undefined} />
          ))}
        </NavSection>
      </Sidebar>
    ),
  },
  {
    name: "Collapsed section",
    states: ["collapsed"],
    render: (context) => (
      <Sidebar context={context}>
        <NavSection collapsed title={text(context).projects}>
          <NavRow icon={<Folder size="md" />} label={text(context).items[0]} />
        </NavSection>
      </Sidebar>
    ),
  },
  {
    // Space sidebar: a heading over custom content (SpaceHeader / SpaceBrowseHeader).
    name: "Heading only (NavSectionHeading)",
    render: (context) => (
      <Sidebar context={context}>
        <Stack gap="md">
          <NavSectionHeading title={text(context).space} actions={<SpaceActions context={context} />} />
          <Stack gap="xs">
            <NavSectionHeading title={text(context).favorites} />
            <Box paddingX="sm">
              <Stack align="row" cross="center" gap="xs">
                <Pin size="sm" />
                <Typo.Caption as="p" tone="secondary">{text(context).favoritesHint}</Typo.Caption>
              </Stack>
            </Box>
          </Stack>
        </Stack>
      </Sidebar>
    ),
  },
];
