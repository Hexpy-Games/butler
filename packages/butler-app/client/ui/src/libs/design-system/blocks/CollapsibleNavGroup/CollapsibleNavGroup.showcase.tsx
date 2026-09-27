import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Folder, FolderOpen, LayoutDashboard, MessageSquarePlus, Notebook } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { NavRow } from "../NavRow";
import { CollapsibleNavGroup } from "./CollapsibleNavGroup";

export const meta: ShowcaseMeta = {
  title: "CollapsibleNavGroup",
  category: "Navigation",
  tags: ["sidebar", "tree", "folder", "collapsible", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    folder: "Design system", sessions: ["Token pages", "Motion trace", "Settings S7"], project: "butler",
    projectSessions: ["Release checklist review", "Queued messages"], dashboard: "Project dashboard", newChat: "New chat in project",
    closed: "Archive", closedItems: ["Old notes"],
  },
  "ko-KR": {
    folder: "디자인 시스템", sessions: ["토큰 페이지", "모션 추적", "설정 S7"], project: "butler",
    projectSessions: ["릴리스 체크리스트 검토", "대기 메시지"], dashboard: "프로젝트 대시보드", newChat: "프로젝트에서 새 채팅",
    closed: "보관함", closedItems: ["이전 메모"],
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Space tree folder (SpaceRow): indented children, open by default. */
function SpaceFolder({ context }: { context: ShowcaseRenderContext }) {
  const [expanded, setExpanded] = useState(true);
  const [closed, setClosed] = useState(false);
  const copy = text(context);
  return (
    <Stack gap="xs">
      <CollapsibleNavGroup indented expanded={expanded} icon={expanded ? <FolderOpen size="md" /> : <Folder size="md" />}
        label={copy.folder} onToggle={() => setExpanded((value) => !value)}>
        {copy.sessions.map((session, index) => (
          <NavRow active={index === 1} icon={<Notebook size="md" />} key={session} label={session} onClick={() => undefined} />
        ))}
      </CollapsibleNavGroup>
      <CollapsibleNavGroup indented expanded={closed} icon={<Folder size="md" />} label={copy.closed} onToggle={() => setClosed((value) => !value)}>
        {copy.closedItems.map((item) => <NavRow icon={<Notebook size="md" />} key={item} label={item} />)}
      </CollapsibleNavGroup>
    </Stack>
  );
}

/** Project group (SidebarProjectGroup): flat children, hover actions on the header. */
function ProjectGroup({ context }: { context: ShowcaseRenderContext }) {
  const [expanded, setExpanded] = useState(true);
  const copy = text(context);
  return (
    <CollapsibleNavGroup
      actions={(
        <ButtonContainer size="icon-sm">
          <IconButton label={copy.dashboard}><LayoutDashboard size="md" /></IconButton>
          <IconButton label={copy.newChat}><MessageSquarePlus size="sm" /></IconButton>
        </ButtonContainer>
      )}
      expanded={expanded}
      icon={expanded ? <FolderOpen /> : <Folder />}
      label={copy.project}
      onToggle={() => setExpanded((value) => !value)}
    >
      {copy.projectSessions.map((session) => <NavRow key={session} label={session} onClick={() => undefined} />)}
    </CollapsibleNavGroup>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Space folders (indented)", states: ["expanded", "collapsed"], widths: ["320", "375", "app"], render: (context) => <SpaceFolder context={context} /> },
  { name: "Project group with actions", states: ["expanded", "hover"], render: (context) => <ProjectGroup context={context} /> },
];
