import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
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
  "en-US": { unread: "Unread", working: "Working", attention: "Needs attention", chat: "Weekly plan review", toggle: "Toggle unread" },
  "ko-KR": { unread: "읽지 않음", working: "작업 중", attention: "확인 필요", chat: "주간 계획 검토", toggle: "읽음 상태 바꾸기" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function EnterExit({ context }: { context: ShowcaseRenderContext }) {
  const [unread, setUnread] = useState(true);
  const copy = text(context);
  return (
    <Stack gap="md">
      <Stack align="row" cross="center" gap="sm">
        <IconSlot size="sidebar"><MessageSquare /></IconSlot>
        <Typo.Text grow truncate>{copy.chat}</Typo.Text>
        <UnreadDot label={copy.unread} present={unread} />
      </Stack>
      <Stack align="row"><Button size="sm" variant="outline" data-ds-motion="replay" text={copy.toggle} onClick={() => setUnread(!unread)} /></Stack>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Enter and exit", states: ["enter", "exit"], render: (context) => <EnterExit context={context} /> },
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
