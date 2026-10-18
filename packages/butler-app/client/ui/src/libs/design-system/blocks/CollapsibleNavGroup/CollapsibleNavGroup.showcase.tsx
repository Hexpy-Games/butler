import { useState, type ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Archive, ChevronDown, ChevronRight, Folder, FolderOpen, LayoutDashboard, Notebook, PencilLine } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { UnreadDot } from "../../components/UnreadDot";
import { NavRow, NavRowSwap } from "../NavRow";
import { OverflowActionMenu } from "../OverflowActionMenu";
import { SidebarShell } from "../SidebarShell";
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
    projectSessions: ["Release checklist review", "Queued messages"], dashboard: "Dashboard",
    closed: "Archive", closedItems: ["Old notes"], menu: "Row actions", rename: "Rename", archive: "Archive",
    expand: "Expand", collapse: "Collapse", unread: "Unread", sidebar: "Sidebar",
  },
  "ko-KR": {
    folder: "디자인 시스템", sessions: ["토큰 페이지", "모션 추적", "설정 S7"], project: "butler",
    projectSessions: ["릴리스 체크리스트 검토", "대기 메시지"], dashboard: "대시보드",
    closed: "보관함", closedItems: ["이전 메모"], menu: "행 작업", rename: "이름 바꾸기", archive: "보관",
    expand: "펼치기", collapse: "접기", unread: "읽지 않음", sidebar: "사이드바",
  },
} as const;

type Copy = (typeof labels)[keyof typeof labels];

function text({ locale }: ShowcaseRenderContext): Copy {
  return labels[locale];
}

/** SpaceRowMenu: the unread dot at rest, the row menu on hover or focus. */
function rowMenu(copy: Copy) {
  return (
    <NavRowSwap rest={<UnreadDot label={copy.unread} present={false} />}>
      <OverflowActionMenu label={copy.menu} items={[
        { icon: <PencilLine size="sm" />, label: copy.rename, onSelect: () => undefined },
        { icon: <Archive size="sm" />, label: copy.archive, onSelect: () => undefined },
      ]} />
    </NavRowSwap>
  );
}

/** SpaceRowActions: a project's dashboard button, then the disclosure chevron that gives way to the row menu. */
function FolderActions({ copy, title, expanded, onToggle, dashboard }: {
  copy: Copy; title: string; expanded: boolean; onToggle: () => void; dashboard?: boolean;
}) {
  return (
    <ButtonContainer size="icon-sm" wrap={false}>
      {dashboard ? <IconButton label={`${title} ${copy.dashboard}`}><LayoutDashboard /></IconButton> : null}
      <NavRowSwap rest={(
        <IconButton tabIndex={-1} label={`${title} ${expanded ? copy.collapse : copy.expand}`} onClick={onToggle}>
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </IconButton>
      )}>
        {rowMenu(copy)}
      </NavRowSwap>
    </ButtonContainer>
  );
}

/** The app's SidebarShell, which sizes row actions and the active fill. */
function Sidebar({ copy, children }: { copy: Copy; children: ReactNode }) {
  return <SidebarShell ariaLabel={copy.sidebar} scrollFade={false}>{children}</SidebarShell>;
}

/** Space tree folder (SpaceRow): indented children, open by default. */
function SpaceFolder({ context }: { context: ShowcaseRenderContext }) {
  const [expanded, setExpanded] = useState(true);
  const [closed, setClosed] = useState(false);
  const copy = text(context);
  return (
    <Sidebar copy={copy}>
      <Stack gap="xs">
        <CollapsibleNavGroup indented stickyDepth={0} expanded={expanded} icon={expanded ? <FolderOpen size="md" /> : <Folder size="md" />}
          label={copy.folder} onToggle={() => setExpanded((value) => !value)}
          actions={<FolderActions copy={copy} title={copy.folder} expanded={expanded} onToggle={() => setExpanded((value) => !value)} />}>
          {copy.sessions.map((session, index) => (
            <NavRow active={index === 1} icon={<Notebook size="md" />} key={session} label={session} onClick={() => undefined} actions={rowMenu(copy)} />
          ))}
        </CollapsibleNavGroup>
        <CollapsibleNavGroup indented stickyDepth={0} expanded={closed} icon={<Folder size="md" />} label={copy.closed} onToggle={() => setClosed((value) => !value)}
          actions={<FolderActions copy={copy} title={copy.closed} expanded={closed} onToggle={() => setClosed((value) => !value)} />}>
          {copy.closedItems.map((item) => <NavRow icon={<Notebook size="md" />} key={item} label={item} actions={rowMenu(copy)} />)}
        </CollapsibleNavGroup>
      </Stack>
    </Sidebar>
  );
}

/** Project folder (SpaceRow): the dashboard button and the row menu on the header. */
function ProjectGroup({ context }: { context: ShowcaseRenderContext }) {
  const [expanded, setExpanded] = useState(true);
  const copy = text(context);
  return (
    <Sidebar copy={copy}>
      <CollapsibleNavGroup
        indented
        stickyDepth={0}
        actions={<FolderActions copy={copy} title={copy.project} expanded={expanded} dashboard onToggle={() => setExpanded((value) => !value)} />}
        expanded={expanded}
        icon={expanded ? <FolderOpen /> : <Folder />}
        label={copy.project}
        onToggle={() => setExpanded((value) => !value)}
      >
        {copy.projectSessions.map((session) => (
          <NavRow icon={<Notebook />} key={session} label={session} onClick={() => undefined} actions={rowMenu(copy)} />
        ))}
      </CollapsibleNavGroup>
    </Sidebar>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Space folders (indented)", states: ["expanded", "collapsed"], widths: ["320", "375", "app"], render: (context) => <SpaceFolder context={context} /> },
  { name: "Project group with actions", states: ["expanded", "hover"], render: (context) => <ProjectGroup context={context} /> },
];
