import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { CheckCircle2, ChevronRight, FileText, MessageSquare } from "../../components/Icons";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { NavRow } from "../NavRow";
import { EventTimeline, EventTimelineItem } from "./EventTimeline";

export const meta: ShowcaseMeta = {
  title: "EventTimeline",
  category: "Dashboard & Metrics",
  tags: ["timeline", "history", "events", "dashboard", "project"],
  status: "stable",
};

const labels = {
  "en-US": {
    date: "September 25, 2026",
    events: [
      { title: "Design system final cleanup: every lint baseline at zero", meta: "9:15 AM · Completion recorded · 2 published artifacts", session: "Final cleanup session with a long title that truncates" },
      { title: "Spec: Butler Dedicated Client Design System", meta: "8:15 AM · Updated" },
      { title: "Plan: move the timeline styling into the DS", meta: "7:15 AM · Created", session: "Planning" },
    ],
  },
  "ko-KR": {
    date: "2026년 9월 25일",
    events: [
      { title: "디자인 시스템 최종 정리: 모든 린트 기준선을 0으로", meta: "오전 9:15 · 완료 기록 · 산출물 2개", session: "제목이 길어서 버튼 안에서 말줄임되는 최종 정리 세션" },
      { title: "Spec: 버틀러 전용 클라이언트 디자인 시스템", meta: "오전 8:15 · 갱신" },
      { title: "Plan: 타임라인 스타일을 DS로 옮기기", meta: "오전 7:15 · 생성", session: "계획" },
    ],
  },
} as const;

const markers = [<CheckCircle2 key="done" />, <FileText key="doc" />, <MessageSquare key="session" />];

// ProjectHistoryPanel: one Section per day, a NavRow per event, the linked session one step in.
function History({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <Section title={copy.date}>
      <EventTimeline>
        {copy.events.map((event, index) => (
          <EventTimelineItem key={event.title} marker={markers[index]}>
            <Stack gap="xs">
              <NavRow label={<Typo.Text lineClamp={2} wrap="anywhere">{event.title}</Typo.Text>} multiline actions={<ChevronRight />}
                meta={<Typo.Caption tone="secondary">{event.meta}</Typo.Caption>} onClick={() => undefined} />
              {"session" in event ? (
                <Box paddingStart="sm">
                  <Button variant="borderless" size="xs" onClick={() => undefined}>
                    <MessageSquare /><Typo.Text truncate>{event.session}</Typo.Text><ChevronRight />
                  </Button>
                </Box>
              ) : null}
            </Stack>
          </EventTimelineItem>
        ))}
      </EventTimeline>
    </Section>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Project history", widths: ["375", "app"], render: (context) => <History context={context} /> },
  {
    name: "Single event",
    render: (context) => (
      <EventTimeline>
        <EventTimelineItem marker={<FileText />}>
          <NavRow label={labels[context.locale].events[1].title} actions={<ChevronRight />} onClick={() => undefined} />
        </EventTimelineItem>
      </EventTimeline>
    ),
  },
];
