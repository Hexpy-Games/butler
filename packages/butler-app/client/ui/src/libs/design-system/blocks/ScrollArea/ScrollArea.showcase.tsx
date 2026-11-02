import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Box } from "../../components/Box";
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
    column: "Column edge",
    item: (index: number) => `Section ${index}`,
  },
  "ko-KR": {
    row: (index: number) => `턴 ${index}: 설정 페이지를 읽고 섹션 헤더를 요약했습니다.`,
    tags: ["토큰 페이지", "모션", "상태 매트릭스", "패턴", "아이콘", "개요", "레시피", "검색"],
    hint: "스크롤하면 내용이 잘리는 가장자리가 흐려지고, 끝에 닿으면 흐림이 사라집니다.",
    column: "열 끝",
    item: (index: number) => `섹션 ${index}`,
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Settings-nav shape: a full-width field above, filled rows below; both must end on the column edge. */
function ColumnRows({ context, count }: { context: ShowcaseRenderContext; count: number }) {
  return (
    <Stack gap="xs">
      <Box surface="muted" radius="control" paddingX="sm" paddingY="xs"><Typo.Caption tone="secondary">{text(context).column}</Typo.Caption></Box>
      <ScrollArea maxHeight="xs">
        <Stack gap="xs">
          {Array.from({ length: count }, (_, index) => (
            <Box key={index} surface="muted" radius="control" paddingX="sm" paddingY="xs"><Typo.Body>{text(context).item(index + 1)}</Typo.Body></Box>
          ))}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    // Settings nav with few sections: rows end on the column edge with either scrollbar style, and no lane is reserved for a scrollbar that is not drawn.
    name: "Content fits",
    render: (context) => <ColumnRows context={context} count={3} />,
  },
  {
    // The same column once it scrolls: a classic scrollbar takes the lane only now, rows keep the column edge.
    // An overlay scrollbar takes no width, so nothing is given back and rows keep the same edge.
    name: "Content overflows",
    render: (context) => <ColumnRows context={context} count={12} />,
  },
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
    // The Box stands in for the inspector's inline padding that the bleed uses.
    name: "Bleed into the inspector gutter",
    render: (context) => (
      <Box paddingX="sm">
        <ScrollArea bleed="inline-end" maxHeight="xs">
          <Stack gap="sm">
            {Array.from({ length: 10 }, (_, index) => <Typo.Body key={index}>{text(context).row(index + 1)}</Typo.Body>)}
          </Stack>
        </ScrollArea>
      </Box>
    ),
  },
  {
    // ContextPanel legend with two categories: minHeight keeps the 96px floor.
    name: "Minimum height",
    render: (context) => (
      <Box paddingX="sm">
        <ScrollArea bleed="inline-end" minHeight="xs">
          <Stack gap="sm">
            {Array.from({ length: 2 }, (_, index) => <Typo.Body key={index}>{text(context).row(index + 1)}</Typo.Body>)}
          </Stack>
        </ScrollArea>
      </Box>
    ),
  },
];
