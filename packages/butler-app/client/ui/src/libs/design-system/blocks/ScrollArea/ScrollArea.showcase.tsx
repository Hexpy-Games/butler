import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Tag } from "../../components/Tag";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ScrollArea } from "./ScrollArea";

export const meta: ShowcaseMeta = {
  title: "ScrollArea",
  category: "Shell",
  tags: ["scroll", "fade", "overflow", "shell"],
  status: "stable",
};

const labels = {
  "en-US": {
    row: (index: number) => `Turn ${index}: read the settings pages and summarized the section headers.`,
    tags: ["Token pages", "Motion", "States matrix", "Patterns", "Icons", "Overview", "Recipes", "Search"],
    hint: "Scroll: the edge that clips content fades; the fade disappears at the boundary.",
  },
  "ko-KR": {
    row: (index: number) => `턴 ${index}: 설정 페이지를 읽고 섹션 헤더를 요약했습니다.`,
    tags: ["토큰 페이지", "모션", "상태 매트릭스", "패턴", "아이콘", "개요", "레시피", "검색"],
    hint: "스크롤하면 내용이 잘리는 가장자리가 흐려지고, 끝에 닿으면 흐림이 사라집니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // A bounded transcript (SessionObserverDialog, DeveloperLogRawBlock): vertical fade on both edges.
    name: "Vertical with edge fades",
    render: (context) => (
      <Stack gap="xs">
        <ScrollArea maxHeight="xs">
          <Stack gap="sm">
            {Array.from({ length: 12 }, (_, index) => <Typo.Body key={index}>{text(context).row(index + 1)}</Typo.Body>)}
          </Stack>
        </ScrollArea>
        <Typo.Caption tone="secondary">{text(context).hint}</Typo.Caption>
      </Stack>
    ),
  },
  {
    name: "Horizontal",
    widths: ["320", "375"],
    render: (context) => (
      <ScrollArea orientation="x">
        <Stack align="row" gap="xs">
          {text(context).tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
        </Stack>
      </ScrollArea>
    ),
  },
  {
    // ContextPanel legend: the scrollbar sits in the inspector gutter; content stays on the column.
    name: "Bleed into the inspector gutter",
    render: (context) => (
      <Stack gap="xs">
        <ScrollArea bleed="inline-end" maxHeight="xs">
          <Stack gap="sm">
            {Array.from({ length: 10 }, (_, index) => <Typo.Body key={index}>{text(context).row(index + 1)}</Typo.Body>)}
          </Stack>
        </ScrollArea>
      </Stack>
    ),
  },
  {
    // ContextPanel legend with two categories: minHeight keeps the 96px floor.
    name: "Minimum height",
    render: (context) => (
      <ScrollArea bleed="inline-end" minHeight="xs">
        <Stack gap="sm">
          {Array.from({ length: 2 }, (_, index) => <Typo.Body key={index}>{text(context).row(index + 1)}</Typo.Body>)}
        </Stack>
      </ScrollArea>
    ),
  },
];
