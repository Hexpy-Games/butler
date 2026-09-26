import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { AutomationRow } from "./AutomationRow";

export const meta: ShowcaseMeta = {
  title: "AutomationRow",
  category: "Dashboard & Metrics",
  tags: ["automation", "schedule", "row", "status"],
  status: "beta",
};

const labels = {
  "en-US": {
    brief: "Morning brief", briefHint: "Summarize active work", weekdays: "Weekdays 08:00", run: "Run",
    audit: "Dependency audit", auditHint: "Check butler-app for outdated packages", weekly: "Every Monday",
    notes: "Nightly release notes", notesHint: "Collect merged PRs", daily: "Every day 07:00",
    active: "Active", paused: "Paused", error: "Last run failed", resume: "Resume", retry: "Retry",
  },
  "ko-KR": {
    brief: "아침 브리핑", briefHint: "진행 중인 작업 요약", weekdays: "평일 08:00", run: "실행",
    audit: "의존성 점검", auditHint: "butler-app의 오래된 패키지 확인", weekly: "매주 월요일",
    notes: "야간 릴리스 노트", notesHint: "병합된 PR 모으기", daily: "매일 07:00",
    active: "활성", paused: "일시 중지", error: "마지막 실행 실패", resume: "다시 시작", retry: "다시 시도",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Tones",
    states: ["active", "paused", "error"],
    widths: ["375", "app"],
    render: (context) => {
      const copy = text(context);
      return (
        <Stack gap="sm">
          <AutomationRow title={copy.brief} description={copy.briefHint} schedule={copy.weekdays} automationTone="active" automationLabel={copy.active}
            actions={<Button size="xs" variant="borderless" text={copy.run} />} />
          <AutomationRow title={copy.audit} description={copy.auditHint} schedule={copy.weekly} automationTone="paused" automationLabel={copy.paused}
            actions={<Button size="xs" variant="borderless" text={copy.resume} />} />
          <AutomationRow title={copy.notes} description={copy.notesHint} schedule={copy.daily} automationTone="error" automationLabel={copy.error}
            actions={<Button size="xs" variant="borderless" text={copy.retry} />} />
        </Stack>
      );
    },
  },
  { name: "Minimal", render: (context) => <AutomationRow title={text(context).brief} schedule={text(context).weekdays} /> },
];
