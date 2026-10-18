import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Archive, Folder, PencilLine, Pin, Trash2 } from "../../components/Icons";
import { UnreadDot } from "../../components/UnreadDot";
import { NavRow, NavRowSwap } from "../NavRow";
import { SidebarShell } from "../SidebarShell";
import { OverflowActionMenu } from "./OverflowActionMenu";

export const meta: ShowcaseMeta = {
  title: "OverflowActionMenu",
  category: "Navigation",
  tags: ["menu", "row-actions", "sidebar", "more"],
  status: "stable",
};

const labels = {
  "en-US": {
    session: "Session actions", project: "Project actions", space: "Space menu", rename: "Rename", pin: "Pin",
    archive: "Archive", remove: "Delete", newProject: "New project", newGroup: "New group", row: "Release checklist review",
    unread: "Unread", sidebar: "Sidebar",
  },
  "ko-KR": {
    session: "세션 작업", project: "프로젝트 작업", space: "스페이스 메뉴", rename: "이름 바꾸기", pin: "고정",
    archive: "보관", remove: "삭제", newProject: "새 프로젝트", newGroup: "새 그룹", row: "릴리스 체크리스트 검토",
    unread: "읽지 않음", sidebar: "사이드바",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function sessionItems(context: ShowcaseRenderContext) {
  const copy = text(context);
  return [
    { icon: <PencilLine size="sm" />, label: copy.rename, onSelect: () => undefined },
    { icon: <Pin size="sm" />, label: copy.pin, onSelect: () => undefined },
    { icon: <Archive size="sm" />, label: copy.archive, onSelect: () => undefined },
    { icon: <Trash2 size="sm" />, label: copy.remove, onSelect: () => undefined, variant: "destructive" as const },
  ];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Session actions",
    states: ["open"],
    render: (context) => <OverflowActionMenu label={text(context).session} items={sessionItems(context)} />,
  },
  {
    // SpaceRowMenu: in the sidebar's row, the menu replaces the row's rest status on hover or focus.
    name: "In a sidebar row",
    widths: ["320", "375", "app"],
    render: (context) => (
      <SidebarShell ariaLabel={text(context).sidebar} scrollFade={false}>
        <NavRow icon={<Folder size="md" />} label={text(context).row} onClick={() => undefined} actions={(
          <NavRowSwap rest={<UnreadDot label={text(context).unread} present={false} />}>
            <OverflowActionMenu label={text(context).session} items={sessionItems(context)} />
          </NavRowSwap>
        )} />
      </SidebarShell>
    ),
  },
  {
    name: "Text-only items (Space header)",
    render: (context) => (
      <OverflowActionMenu label={text(context).space} items={[
        { label: text(context).newProject, onSelect: () => undefined },
        { label: text(context).newGroup, onSelect: () => undefined },
      ]} />
    ),
  },
];
