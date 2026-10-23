import { useState, type ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { NavRow } from "../../blocks/NavRow";
import { SidebarShell } from "../../blocks/SidebarShell";
import { Button } from "../Button";
import { Card } from "../Card";
import { Bot, Circle, Notebook } from "../Icons";
import { IconSlot } from "../IconSlot";
import { Inline } from "../Inline";
import { Spinner } from "../Spinner";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Avatar, type AvatarSize } from "./Avatar";

export const meta: ShowcaseMeta = {
  title: "Avatar",
  category: "Data display",
  tags: ["avatar", "initials", "assignee", "person", "badge", "agent"],
  status: "beta",
};

const labels = {
  "en-US": {
    me: "Yeonwoo", minji: "minji", dohyun: "Dohyun", elodie: "Élodie", meTip: "Yeonwoo (me)", minjiTip: "minji",
    working: "Yeonwoo · Claude Code working", task: "Visualization blocks", task2: "Docs", caption: "2nd · Tasks 1/3",
    run: "Working", toggle: "Toggle agent", sidebar: "Sidebar",
  },
  "ko-KR": {
    me: "연우", minji: "minji", dohyun: "도현", elodie: "Élodie", meTip: "연우 (나)", minjiTip: "minji 님",
    working: "연우 · Claude Code 작업 중", task: "시각화 블록", task2: "문서", caption: "2번째 · 작업 1/3",
    run: "작업 중", toggle: "에이전트 표시 바꾸기", sidebar: "사이드바",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const SIZES: AvatarSize[] = ["xs", "sm", "md"];
const agentMark = <Bot />;

/** A title with its assignee right after it; the title truncates first. */
function TitleWithAvatar({ title, avatar }: { title: string; avatar: ReactNode }) {
  return (
    <Inline gap="xs" wrap={false}>
      <Typo.Text truncate>{title}</Typo.Text>
      {avatar}
    </Inline>
  );
}

function BadgeToggle({ context }: { context: ShowcaseRenderContext }) {
  const [working, setWorking] = useState(true);
  const copy = text(context);
  return (
    <Stack gap="md">
      <Inline gap="md">
        {SIZES.map((size) => (
          <Avatar key={size} size={size} name={copy.me} label={working ? copy.working : copy.meTip}
            badge={working ? agentMark : null} />
        ))}
      </Inline>
      <Stack align="row">
        <Button size="sm" variant="outline" data-ds-motion="replay" text={copy.toggle} onClick={() => setWorking(!working)} />
      </Stack>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Sizes and tones",
    render: (context) => (
      <Stack gap="md">
        {(["self", "other"] as const).map((tone) => (
          <Inline key={tone} gap="md">
            {SIZES.map((size) => (
              <Avatar key={size} size={size} tone={tone} name={tone === "self" ? text(context).me : text(context).minji} />
            ))}
          </Inline>
        ))}
      </Stack>
    ),
  },
  {
    name: "Initials from names",
    render: (context) => {
      const copy = text(context);
      return (
        <Inline gap="md">
          <Avatar size="md" name={copy.me} label={copy.meTip} />
          {[copy.minji, copy.dohyun, copy.elodie].map((name) => <Avatar key={name} size="md" tone="other" name={name} />)}
        </Inline>
      );
    },
  },
  { name: "Agent badge", states: ["enter", "exit"], render: (context) => <BadgeToggle context={context} /> },
  {
    name: "Sidebar row",
    render: (context) => {
      const copy = text(context);
      return (
        <SidebarShell ariaLabel={copy.sidebar} scrollFade={false}>
          <NavRow icon={<Notebook />} active onClick={() => undefined} ariaLabel={copy.task} ariaDescription={copy.working}
            label={<TitleWithAvatar title={copy.task} avatar={<Avatar name={copy.me} label={copy.working} badge={agentMark} />} />}
            actions={<IconSlot size="sidebar" minHeight="line" passive role="status" aria-label={copy.run}><Spinner /></IconSlot>} />
          <NavRow icon={<Notebook />} onClick={() => undefined} ariaLabel={copy.task2}
            label={<TitleWithAvatar title={copy.task2} avatar={<Avatar tone="other" name={copy.minji} label={copy.minjiTip} />} />} />
        </SidebarShell>
      );
    },
  },
  {
    name: "Card title",
    render: (context) => {
      const copy = text(context);
      return (
        <Card padding="sm">
          <Stack gap="xs">
            <Inline gap="sm" wrap={false}>
              <IconSlot size="sm"><Circle size="sm" /></IconSlot>
              <TitleWithAvatar title={copy.task} avatar={<Avatar name={copy.me} label={copy.working} badge={agentMark} />} />
            </Inline>
            <Typo.Caption tone="secondary">{copy.caption}</Typo.Caption>
          </Stack>
        </Card>
      );
    },
  },
];
