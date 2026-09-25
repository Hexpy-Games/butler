import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { CheckCircle2, CircleAlert, ListChecks } from "../Icons";
import { Inline } from "../Inline";
import { Tag, type TagTone } from "./Tag";

export const meta: ShowcaseMeta = {
  title: "Tag",
  category: "Data display",
  tags: ["tag", "badge", "chip", "tone"],
  status: "stable",
};

const labels = {
  "en-US": { neutral: "Draft", accent: "Plan", success: "Done", warning: "Needs review", danger: "Failed", remove: "Remove plan mode" },
  "ko-KR": { neutral: "초안", accent: "계획", success: "완료", warning: "검토 필요", danger: "실패", remove: "계획 모드 해제" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const tones: TagTone[] = ["neutral", "accent", "success", "warning", "danger"];

export const stories: ShowcaseStory[] = [
  {
    name: "Tones",
    render: (context) => (
      <Inline>{tones.map((tone) => <Tag key={tone} tone={tone}>{text(context)[tone]}</Tag>)}</Inline>
    ),
  },
  {
    name: "With icon",
    render: (context) => (
      <Inline>
        <Tag icon={<ListChecks aria-hidden="true" size="xs" />}>{text(context).accent}</Tag>
        <Tag tone="success" icon={<CheckCircle2 aria-hidden="true" size="xs" />}>{text(context).success}</Tag>
        <Tag tone="danger" icon={<CircleAlert aria-hidden="true" size="xs" />}>{text(context).danger}</Tag>
      </Inline>
    ),
  },
  {
    name: "Removable",
    render: (context) => (
      <Tag icon={<ListChecks aria-hidden="true" size="xs" />} onRemove={() => undefined} removeLabel={text(context).remove}>
        {text(context).accent}
      </Tag>
    ),
  },
];
