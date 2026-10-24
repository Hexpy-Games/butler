import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { DropdownMenuItem } from "../DropdownMenu";
import { CheckCircle2, ChevronRight, CircleAlert, ListChecks } from "../Icons";
import { Inline } from "../Inline";
import { Tag, tagLabelTones, type TagTone } from "./Tag";
import { OnWallpapers, tagLabelToneNames } from "./Tag.demo";

export const meta: ShowcaseMeta = {
  title: "Tag",
  category: "Data display",
  tags: ["tag", "badge", "chip", "tone"],
  status: "stable",
};

const labels = {
  "en-US": { neutral: "Draft", accent: "Plan", success: "Done", warning: "Needs review", danger: "Failed", remove: "Remove plan mode", eyebrow: "Foundations · 196 tokens",
    label: "design", edit: "design tag menu", removeLabel: "Remove design", rename: "Rename", recolor: "Change color", delete: "Delete" },
  "ko-KR": { neutral: "초안", accent: "계획", success: "완료", warning: "검토 필요", danger: "실패", remove: "계획 모드 해제", eyebrow: "기초 · 토큰 196개",
    label: "디자인", edit: "디자인 태그 메뉴", removeLabel: "디자인 빼기", rename: "이름 바꾸기", recolor: "색 바꾸기", delete: "삭제" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const tones = ["neutral", "accent", "success", "warning", "danger"] as const satisfies readonly TagTone[];

/** CanonTagsField: an attached label in an editable field, with its edit menu before remove. */
function EditableTag(context: ShowcaseRenderContext) {
  const copy = text(context);
  return (
    <Tag tone="teal" onRemove={() => undefined} removeLabel={copy.removeLabel} editLabel={copy.edit} editMenu={<>
      <DropdownMenuItem>{copy.rename}</DropdownMenuItem>
      <DropdownMenuItem>{copy.recolor}</DropdownMenuItem>
      <DropdownMenuItem variant="destructive">{copy.delete}</DropdownMenuItem>
    </>}>{copy.label}</Tag>
  );
}

function LabelTones({ locale }: ShowcaseRenderContext) {
  const names = tagLabelToneNames[locale];
  return <Inline>{tagLabelTones.map((tone) => <Tag key={tone} tone={tone}>{names[tone]}</Tag>)}</Inline>;
}

export const stories: ShowcaseStory[] = [
  {
    name: "Tones",
    render: (context) => (
      <Inline>{tones.map((tone) => <Tag key={tone} tone={tone}>{text(context)[tone]}</Tag>)}</Inline>
    ),
  },
  {
    name: "Label tones",
    render: (context) => <LabelTones {...context} />,
  },
  {
    name: "Label tones on wallpaper",
    widths: ["app", "375"],
    render: (context) => <OnWallpapers><LabelTones {...context} /></OnWallpapers>,
  },
  {
    name: "Sizes",
    render: (context) => (
      <Inline>
        <Tag>{text(context).neutral}</Tag>
        <Tag size="md">{text(context).neutral}</Tag>
        <Tag tone="accent" icon={<ListChecks aria-hidden="true" size="xs" />}>{text(context).accent}</Tag>
        <Tag tone="accent" size="md" icon={<ListChecks aria-hidden="true" size="xs" />}>{text(context).accent}</Tag>
        <Tag tone="accent" size="md">{text(context).eyebrow}</Tag>
      </Inline>
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
    name: "Trailing icon",
    render: () => (
      <Inline>
        <Tag iconEnd={<ChevronRight aria-hidden="true" size="xs" />}>+4</Tag>
        <Tag iconEnd={<ChevronRight aria-hidden="true" size="xs" />}>+12</Tag>
        <Tag size="md" iconEnd={<ChevronRight aria-hidden="true" size="xs" />}>+4</Tag>
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
  {
    name: "Editable",
    render: (context) => (
      <Inline>
        <EditableTag {...context} />
        <Tag tone="teal">{text(context).label}</Tag>
      </Inline>
    ),
  },
];
