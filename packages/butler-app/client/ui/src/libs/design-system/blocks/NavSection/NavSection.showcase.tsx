import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Box } from "../../components/Box";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Folder, FolderPlus, Pin, Plus } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { NavRow } from "../NavRow";
import { NavSection, NavSectionHeading } from "./index";

export const meta: ShowcaseMeta = {
  title: "NavSection",
  category: "Navigation",
  tags: ["sidebar", "section", "heading", "navigation"],
  status: "stable",
};

const labels = {
  "en-US": {
    projects: "Projects", newProject: "New project", space: "Space", createGroup: "New group",
    favorites: "Favorites", favoritesHint: "Star a conversation or folder to keep it here.",
    items: ["butler", "butler-site", "research-notes"],
  },
  "ko-KR": {
    projects: "프로젝트", newProject: "새 프로젝트", space: "스페이스", createGroup: "새 그룹",
    favorites: "즐겨찾기", favoritesHint: "대화나 폴더에 별표를 달면 여기에 모입니다.",
    items: ["butler", "butler-site", "research-notes"],
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Sidebar section (SidebarSection)",
    widths: ["320", "375", "app"],
    render: (context) => (
      <NavSection title={text(context).projects} actions={<IconButton label={text(context).newProject}><FolderPlus size="md" /></IconButton>}>
        {text(context).items.map((item, index) => (
          <NavRow active={index === 0} icon={<Folder size="md" />} key={item} label={item} onClick={() => undefined} />
        ))}
      </NavSection>
    ),
  },
  {
    name: "Collapsed section",
    states: ["collapsed"],
    render: (context) => (
      <NavSection collapsed title={text(context).projects}>
        <NavRow icon={<Folder size="md" />} label={text(context).items[0]} />
      </NavSection>
    ),
  },
  {
    // Space sidebar: a heading over custom content (SpaceHeader / SpaceBrowseHeader).
    name: "Heading only (NavSectionHeading)",
    render: (context) => (
      <Stack gap="md">
        <NavSectionHeading title={text(context).space}
          actions={<ButtonContainer size="icon-sm"><IconButton label={text(context).createGroup}><Plus /></IconButton></ButtonContainer>} />
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
    ),
  },
];
