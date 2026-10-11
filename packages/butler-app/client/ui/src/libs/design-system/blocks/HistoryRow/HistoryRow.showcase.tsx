import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { MessageSquare, Trash2 } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { ICONS } from "../TabStrip/TabStrip.demo";
import { HistoryGroup, HistoryRow } from "./HistoryRow";

export const meta: ShowcaseMeta = {
  title: "HistoryRow",
  category: "Browser",
  tags: ["browser", "history", "visits", "favicon", "selection", "row", "time"],
  status: "beta",
};

interface Visit { id: number; title: string; url: string; icon?: string; time: string; conversation?: boolean }

const COPY: Record<ShowcaseRenderContext["locale"], { today: string; yesterday: string; remove: string; conversation: string; visits: Visit[] }> = {
  "en-US": {
    today: "Today - Sunday, October 11, 2026", yesterday: "Yesterday - Saturday, October 10, 2026", remove: "Delete", conversation: "Open conversation",
    visits: [
      { id: 1, title: "Docs - Getting started with the desktop app", url: "https://docs.example.com/guides/getting-started", icon: ICONS.docs, time: "8:27 PM" },
      { id: 2, title: "Inbox (3)", url: "https://mail.example.net/inbox", icon: ICONS.mail, time: "8:12 PM", conversation: true },
      { id: 3, title: "Office chairs - Shop", url: "https://shop.example.com/search?q=office-chair", icon: ICONS.shop, time: "11:04 AM" },
      { id: 4, title: "", url: "https://status.example.org/", icon: ICONS.broken, time: "9:30 AM" },
    ],
  },
  "ko-KR": {
    today: "오늘 - 2026년 10월 11일 일요일", yesterday: "어제 - 2026년 10월 10일 토요일", remove: "삭제", conversation: "대화 열기",
    visits: [
      { id: 1, title: "개발 문서 - 데스크톱 앱 시작하기", url: "https://docs.example.com/guides/getting-started", icon: ICONS.docs, time: "오후 08:27" },
      { id: 2, title: "받은편지함 (3)", url: "https://mail.example.net/inbox", icon: ICONS.mail, time: "오후 08:12", conversation: true },
      { id: 3, title: "사무용 의자 - 쇼핑", url: "https://shop.example.com/search?q=office-chair", icon: ICONS.shop, time: "오전 11:04" },
      { id: 4, title: "", url: "https://status.example.org/", icon: ICONS.broken, time: "오전 09:30" },
    ],
  },
};

function actions(copy: (typeof COPY)["en-US"], visit: Visit) {
  return (
    <ButtonContainer size="icon-sm">
      {visit.conversation ? <IconButton label={copy.conversation}><MessageSquare size="md" /></IconButton> : null}
      <IconButton label={`${copy.remove}: ${visit.title || visit.url}`}><Trash2 size="md" /></IconButton>
    </ButtonContainer>
  );
}

/** HistoryPage in miniature: rows open on click; Select turns them into check boxes. */
function Day({ locale, selecting }: ShowcaseRenderContext & { selecting: boolean }) {
  const copy = COPY[locale];
  const [selected, setSelected] = useState<number[]>([2]);
  return (
    <Stack gap="lg">
      <HistoryGroup title={copy.today}>
        {copy.visits.slice(0, 2).map((visit) => (
          <HistoryRow key={visit.id} rowId={visit.id} title={visit.title} url={visit.url} iconSrc={visit.icon} time={visit.time} onOpen={() => undefined}
            actions={actions(copy, visit)} selecting={selecting} selected={selected.includes(visit.id)}
            onSelectedChange={(on) => setSelected((ids) => (on ? [...ids, visit.id] : ids.filter((id) => id !== visit.id)))} />
        ))}
      </HistoryGroup>
      <HistoryGroup title={copy.yesterday}>
        {copy.visits.slice(2).map((visit) => (
          <HistoryRow key={visit.id} rowId={visit.id} title={visit.title} url={visit.url} iconSrc={visit.icon} time={visit.time} onOpen={() => undefined}
            actions={actions(copy, visit)} selecting={selecting} selected={selected.includes(visit.id)}
            onSelectedChange={(on) => setSelected((ids) => (on ? [...ids, visit.id] : ids.filter((id) => id !== visit.id)))} />
        ))}
      </HistoryGroup>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Days of visits (hover shows the actions)", states: ["hover", "focus-visible"], widths: ["375", "app"], render: (context) => <Day {...context} selecting={false} /> },
  { name: "Selection mode", states: ["selected"], widths: ["375", "app"], render: (context) => <Day {...context} selecting /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "selected"],
  variants: ["browse", "select"],
  render: ({ locale, state, variant }) => {
    const copy = COPY[locale];
    const visit = copy.visits[1]!;
    return (
      <HistoryRow title={visit.title} url={visit.url} iconSrc={visit.icon} time={visit.time} onOpen={() => undefined} actions={actions(copy, visit)}
        selecting={variant === "select"} selected={state === "selected"} />
    );
  },
};
