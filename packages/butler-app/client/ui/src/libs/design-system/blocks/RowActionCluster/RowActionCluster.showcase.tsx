import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { Folder, LayoutDashboard, MessageSquarePlus, Pencil, Trash2 } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { NavRow } from "../NavRow";
import { RowActionCluster } from "./RowActionCluster";

export const meta: ShowcaseMeta = {
  title: "RowActionCluster",
  category: "Navigation",
  tags: ["row-actions", "sidebar", "icon-button"],
  status: "beta",
};

const labels = {
  "en-US": { project: "butler", dashboard: "Project dashboard", newChat: "New chat in project", edit: "Edit", remove: "Delete" },
  "ko-KR": { project: "butler", dashboard: "프로젝트 대시보드", newChat: "프로젝트에서 새 채팅", edit: "편집", remove: "삭제" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function Actions({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <RowActionCluster>
      <IconButton label={copy.dashboard}><LayoutDashboard size="md" /></IconButton>
      <IconButton label={copy.newChat}><MessageSquarePlus size="sm" /></IconButton>
    </RowActionCluster>
  );
}

export const stories: ShowcaseStory[] = [
  {
    // Clicks inside the cluster never reach the row; buttons follow --sidebar-action-size.
    name: "Trailing row actions",
    widths: ["320", "375", "app"],
    render: (context) => (
      <NavRow icon={<Folder size="md" />} label={text(context).project} onClick={() => undefined}
        actions={<Actions context={context} />} actionsVisibility="hover" />
    ),
  },
  {
    name: "Standalone",
    render: (context) => (
      <Stack align="row">
        <RowActionCluster size="sm">
          <IconButton label={text(context).edit}><Pencil size="sm" /></IconButton>
          <IconButton label={text(context).remove}><Trash2 size="sm" /></IconButton>
        </RowActionCluster>
      </Stack>
    ),
  },
];
