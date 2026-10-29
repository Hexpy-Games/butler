import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Activity, Circle, FileText } from "../../components/Icons";
import { Section } from "../../components/Section";
import { Stack } from "../../components/Stack";
import { EmptyLine } from "../EmptyLine";
import { KeyValueRow } from "../KeyValueRow";
import { ListRow } from "../ListRow";
import { InspectorInset } from "./InspectorInset";
import { InspectorPanel } from "./InspectorPanel";

export const meta: ShowcaseMeta = {
  title: "InspectorPanel",
  category: "Inspector",
  tags: ["inspector", "panel", "summary"],
  status: "stable",
};

const labels = {
  "en-US": {
    branch: "Branch details", gateway: "Gateway", ready: "Ready", branchLabel: "Git branch", skills: "Skills",
    noSkills: "No skills used in this conversation.", workers: "Workers", context: "Context", contextMeta: "Last updated just now",
    tokens: "Tokens", files: "Files", refresh: "Refresh", schedules: "Schedules", nightly: "Nightly release notes", every: "Every day 07:00",
  },
  "ko-KR": {
    branch: "브랜치 정보", gateway: "게이트웨이", ready: "준비됨", branchLabel: "Git 브랜치", skills: "스킬",
    noSkills: "이 대화에서 사용한 스킬이 없습니다.", workers: "작업자", context: "컨텍스트", contextMeta: "방금 갱신됨",
    tokens: "토큰", files: "파일", refresh: "새로고침", schedules: "예약 작업", nightly: "야간 릴리스 노트", every: "매일 07:00",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Summary: branch details",
    render: (context) => (
      <InspectorPanel title={text(context).branch}>
        <KeyValueRow label={text(context).gateway} value={text(context).ready} />
        <KeyValueRow label={text(context).branchLabel} value="main" />
      </InspectorPanel>
    ),
  },
  {
    name: "Icon, description and action",
    render: (context) => (
      <InspectorPanel title={text(context).context} description={text(context).contextMeta} icon={<Activity size="md" />}
        action={<Button size="xs" variant="borderless" text={text(context).refresh} />}>
        <KeyValueRow label={text(context).tokens} value="18,240" meta="62%" />
        <KeyValueRow label={text(context).files} value="8" />
      </InspectorPanel>
    ),
  },
  {
    name: "Skills list and empty state",
    render: (context) => (
      <InspectorPanel title={text(context).skills}>
        <ListRow icon={<FileText size="md" />} title="butler-design-system" />
        <EmptyLine icon={<Circle size="md" />} message={text(context).noSkills} />
      </InspectorPanel>
    ),
  },
  {
    name: "Panel beside an inset Section",
    render: (context) => (
      <Stack gap="md">
        <InspectorPanel title={text(context).branch}>
          <KeyValueRow label={text(context).gateway} value={text(context).ready} />
        </InspectorPanel>
        {/* Full-width content that is not a panel card aligns through InspectorInset. */}
        <InspectorInset>
          <Section title={text(context).schedules} gap="sm">
            <ListRow icon={<FileText size="md" />} title={text(context).nightly} meta={text(context).every} />
          </Section>
        </InspectorInset>
      </Stack>
    ),
  },
];
