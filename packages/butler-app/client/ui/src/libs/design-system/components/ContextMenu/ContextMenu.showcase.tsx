import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { MessageRow } from "../../blocks/MessageRow";
import { Copy, GitBranch, Trash2 } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./ContextMenu";

export const meta: ShowcaseMeta = {
  title: "ContextMenu",
  category: "Overlay",
  tags: ["menu", "secondary-action", "conversation", "glass", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    hint: "Right-click (or long-press) the message.", message: "Compacted 42 earlier turns into a summary to free context.",
    copy: "Copy", branch: "Branch from here", remove: "Delete", unavailable: "Delete (not allowed for system messages)",
  },
  "ko-KR": {
    hint: "메시지를 오른쪽 클릭하거나 길게 누르세요.", message: "컨텍스트를 확보하려고 이전 42개 턴을 요약했습니다.",
    copy: "복사", branch: "여기서 분기", remove: "삭제", unavailable: "삭제 (시스템 메시지는 삭제할 수 없음)",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // VirtualMessageRow: system messages expose Copy through a context menu.
    name: "Message copy menu",
    states: ["open"],
    render: (context) => (
      <Stack gap="sm">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <MessageRow role="system" compactionEvent>
              <Typo.Body>{text(context).message}</Typo.Body>
            </MessageRow>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem><Copy size="sm" /><span>{text(context).copy}</span></ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <Typo.Caption tone="secondary">{text(context).hint}</Typo.Caption>
      </Stack>
    ),
  },
  {
    name: "Destructive and disabled items",
    states: ["disabled"],
    render: (context) => (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Typo.Body>{text(context).hint}</Typo.Body>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem><Copy size="sm" /><span>{text(context).copy}</span></ContextMenuItem>
          <ContextMenuItem inset><GitBranch size="sm" /><span>{text(context).branch}</span></ContextMenuItem>
          <ContextMenuItem variant="destructive"><Trash2 size="sm" /><span>{text(context).remove}</span></ContextMenuItem>
          <ContextMenuItem disabled><span>{text(context).unavailable}</span></ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    ),
  },
];
