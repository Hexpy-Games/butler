import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Archive, Folder, PencilLine, Pin, Trash2 } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { NavRow } from "../NavRow";
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
  },
  "ko-KR": {
    session: "세션 작업", project: "프로젝트 작업", space: "스페이스 메뉴", rename: "이름 바꾸기", pin: "고정",
    archive: "보관", remove: "삭제", newProject: "새 프로젝트", newGroup: "새 그룹", row: "릴리스 체크리스트 검토",
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
    // SidebarSessionActions: the menu sits in a NavRow's trailing actions.
    name: "In a sidebar row",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Stack gap="xs">
        <NavRow icon={<Folder size="md" />} label={text(context).row} onClick={() => undefined} actionsVisibility="hover"
          actions={<OverflowActionMenu label={text(context).session} items={sessionItems(context)} />} />
      </Stack>
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
