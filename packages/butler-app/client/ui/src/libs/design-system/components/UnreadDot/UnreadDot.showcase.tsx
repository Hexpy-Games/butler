import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { CircleAlert, MessageSquare } from "../Icons";
import { IconSlot } from "../IconSlot";
import { Spinner } from "../Spinner";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { UnreadDot } from "./UnreadDot";

export const meta: ShowcaseMeta = {
  title: "UnreadDot",
  category: "Feedback",
  tags: ["unread", "new", "dot", "badge", "status", "indicator"],
  status: "beta",
};

const labels = {
  "en-US": { unread: "Unread", working: "Working", attention: "Needs attention", chat: "Weekly plan review" },
  "ko-KR": { unread: "읽지 않음", working: "작업 중", attention: "확인 필요", chat: "주간 계획 검토" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Sizes",
    render: (context) => (
      <Stack align="row" cross="center" gap="md">
        {(["sm", "md", "lg"] as const).map((size) => <UnreadDot key={size} size={size} label={text(context).unread} />)}
      </Stack>
    ),
  },
  {
    name: "Trailing status column",
    render: (context) => (
      <Stack gap="sm">
        {([
          ["unread", <UnreadDot key="unread" label={text(context).unread} />],
          ["working", <IconSlot key="working" size="sidebar" minHeight="line" passive role="status" aria-label={text(context).working}><Spinner /></IconSlot>],
          ["attention", <IconSlot key="attention" size="sidebar" minHeight="line" passive role="status" aria-label={text(context).attention}><CircleAlert /></IconSlot>],
        ] as const).map(([state, mark]) => (
          <Stack key={state} align="row" cross="center" gap="sm">
            <IconSlot size="sidebar"><MessageSquare /></IconSlot>
            <Typo.Text grow truncate>{text(context).chat}</Typo.Text>
            {mark}
          </Stack>
        ))}
      </Stack>
    ),
  },
];
