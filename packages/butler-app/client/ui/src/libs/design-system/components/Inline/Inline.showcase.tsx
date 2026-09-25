import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { GitBranch } from "../Icons";
import { Tag } from "../Tag";
import { Typo } from "../Typo";
import { Inline } from "./Inline";

export const meta: ShowcaseMeta = {
  title: "Inline",
  category: "Layout",
  tags: ["layout", "row", "wrap", "chips"],
  status: "stable",
};

const labels = {
  "en-US": {
    chips: ["Design system", "Typography", "Layout", "Settings", "Dashboard", "Korean copy", "Tabular numbers"],
    branch: "feature/ds-step-4", meta: "Updated 2 minutes ago",
  },
  "ko-KR": {
    chips: ["디자인 시스템", "타이포그래피", "레이아웃", "설정", "대시보드", "한국어 문구", "고정폭 숫자"],
    branch: "feature/ds-step-4", meta: "2분 전 업데이트",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Chip row",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Inline>
        {text(context).chips.map((chip) => <Tag key={chip}>{chip}</Tag>)}
      </Inline>
    ),
  },
  {
    name: "Icon and metadata",
    render: (context) => (
      <Inline gap="xs">
        <GitBranch size="xs" aria-hidden="true" />
        <Typo.Caption>{text(context).branch}</Typo.Caption>
        <Typo.Caption tone="tertiary">·</Typo.Caption>
        <Typo.Caption tone="secondary">{text(context).meta}</Typo.Caption>
      </Inline>
    ),
  },
  {
    name: "Separate row gap",
    widths: ["320", "375"],
    render: (context) => (
      <Inline gap="lg" rowGap="sm">
        {text(context).chips.map((chip) => <Typo.Body key={chip}>{chip}</Typo.Body>)}
      </Inline>
    ),
  },
  {
    name: "No wrap",
    widths: ["320", "375"],
    render: (context) => (
      <Inline wrap={false}>
        {text(context).chips.slice(0, 3).map((chip) => <Tag key={chip}>{chip}</Tag>)}
      </Inline>
    ),
  },
];
