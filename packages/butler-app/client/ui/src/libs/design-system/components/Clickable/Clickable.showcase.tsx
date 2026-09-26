import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ListRow } from "../../blocks/ListRow";
import { Clock3, FileText, Sparkles } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Clickable } from "./Clickable";

export const meta: ShowcaseMeta = {
  title: "Clickable",
  category: "Action",
  tags: ["role-button", "nested-action", "row", "text"],
  status: "stable",
};

const labels = {
  "en-US": {
    suggestion: "Summarize today's changes",
    automations: [
      { title: "Nightly release notes", target: "butler · main", meta: "active / Every day 07:00" },
      { title: "Dependency audit", target: "butler-app", meta: "paused / Every Monday" },
    ],
    artifact: "Design review notes.md",
    decision: "Allow Butler to run the migration script against the staging database once the backup finishes",
    every: "Every hour",
  },
  "ko-KR": {
    suggestion: "오늘 변경 사항 요약하기",
    automations: [
      { title: "야간 릴리스 노트", target: "butler · main", meta: "활성 / 매일 07:00" },
      { title: "의존성 점검", target: "butler-app", meta: "일시 중지 / 매주 월요일" },
    ],
    artifact: "디자인 검토 메모.md",
    decision: "백업이 끝나면 스테이징 데이터베이스에 마이그레이션 스크립트를 실행하도록 Butler에게 허용하기",
    every: "매시간",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Prompt suggestion (Display.tsx `Suggestion`): intrinsic-width icon + text row. */
function Suggestion({ context, disabled }: { context: ShowcaseRenderContext; disabled?: boolean }) {
  return (
    <Clickable disabled={disabled} onClick={() => undefined} aria-label={text(context).suggestion}>
      <Sparkles size="md" />
      <span>{text(context).suggestion}</span>
    </Clickable>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Suggestion row", render: (context) => <Suggestion context={context} /> },
  {
    name: "Stretched list rows",
    states: ["selected"],
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="xs">
        {text(context).automations.map((automation, index) => (
          <Clickable aria-current={index === 0 ? "page" : undefined} key={automation.title} onClick={() => undefined} stretch>
            <ListRow title={automation.title} description={automation.target} meta={automation.meta} />
          </Clickable>
        ))}
        <Clickable onClick={() => undefined} stretch>
          <ListRow icon={<Clock3 size="md" />} title={text(context).automations[1].title} meta={text(context).every} />
        </Clickable>
      </Stack>
    ),
  },
  {
    name: "Artifact row",
    render: (context) => (
      <Clickable aria-current="true" onClick={() => undefined} aria-label={text(context).artifact}>
        <ListRow icon={<FileText size="md" />} title={text(context).artifact} />
      </Clickable>
    ),
  },
  {
    name: "Text variant (decision title)",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Clickable variant="text" onClick={() => undefined} title={text(context).decision}>
        <Typo.Label weight="medium" tone="primary" lineClamp={2} wrap="anywhere">{text(context).decision}</Typo.Label>
      </Clickable>
    ),
  },
  { name: "Disabled", states: ["disabled"], render: (context) => <Suggestion context={context} disabled /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "disabled"],
  variants: ["row", "text"],
  render: (context) => context.variant === "text" ? (
    <Clickable variant="text" disabled={context.state === "disabled"} onClick={() => undefined}>
      <Typo.Label weight="medium" tone="primary">{text(context).artifact}</Typo.Label>
    </Clickable>
  ) : <Suggestion context={context} disabled={context.state === "disabled"} />,
};
