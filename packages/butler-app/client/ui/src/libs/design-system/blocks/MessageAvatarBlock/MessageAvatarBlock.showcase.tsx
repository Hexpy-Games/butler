import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Bot, Sparkles } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { MessageAvatarBlock } from "./MessageAvatarBlock";

export const meta: ShowcaseMeta = {
  title: "MessageAvatarBlock",
  category: "Conversation & Activity",
  tags: ["avatar", "message", "system"],
  status: "stable",
};

const labels = {
  "en-US": { system: "System messages keep a Bot avatar; assistant turns show the Butler mark in the status line instead.", roles: "assistant (active) · user · system" },
  "ko-KR": { system: "시스템 메시지는 Bot 아바타를 쓰고, 어시스턴트 턴은 상태 줄에 버틀러 마크를 보여 줍니다.", roles: "assistant (active) · user · system" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // MessageAvatar: the product renders it for system messages only.
    name: "System message avatar",
    render: (context) => (
      <Stack align="row" cross="center" gap="sm">
        <MessageAvatarBlock role="system"><Bot size="md" /></MessageAvatarBlock>
        <Typo.Caption tone="secondary">{text(context).system}</Typo.Caption>
      </Stack>
    ),
  },
  {
    name: "Roles",
    render: (context) => (
      <Stack gap="sm">
        <Stack align="row" gap="sm">
          <MessageAvatarBlock active><Sparkles size="md" /></MessageAvatarBlock>
          <MessageAvatarBlock role="user" />
          <MessageAvatarBlock role="system" />
        </Stack>
        <Typo.Caption tone="secondary">{text(context).roles}</Typo.Caption>
      </Stack>
    ),
  },
];
