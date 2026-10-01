import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Card } from "../Card";
import { PageContainer } from "../PageContainer";
import { Typo } from "../Typo";
import { Stack } from "../Stack";
import { Grid, type GridColumnPreset } from "./Grid";

export const meta: ShowcaseMeta = {
  title: "Grid",
  category: "Layout",
  tags: ["layout", "grid", "columns", "span"],
  status: "stable",
};

const labels = {
  "en-US": { cell: "Cell", wide: "Spans two columns", full: "Spans the full row", main: "Main content", aside: "Aside" },
  "ko-KR": { cell: "셀", wide: "두 칸 차지", full: "한 줄 전체 차지", main: "주요 내용", aside: "보조 영역" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const LONG_VALUE = "/Users/butler/Projects/workspace/packages/client/src/components/management/ProjectDocumentMarkdownContent.tsx";
const presetCells: Array<[GridColumnPreset, number]> = [
  ["1", 1], ["2", 2], ["3", 3], ["4", 4], ["6", 6], ["12", 12],
  ["auto-fit", 3], ["auto-fill", 3], ["main-aside", 2], ["label-value", 2],
];

function Cell({ children }: { children: string }) {
  return <Card><Typo.Body>{children}</Typo.Body></Card>;
}

export const stories: ShowcaseStory[] = [
  {
    name: "Auto-fit",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <Grid gap="md">
        {[1, 2, 3, 4].map((index) => <Cell key={index}>{`${text(context).cell} ${index}`}</Cell>)}
      </Grid>
    ),
  },
  {
    name: "Span",
    render: (context) => (
      <Grid columns="3" gap="sm">
        <Grid.Item span="2"><Cell>{text(context).wide}</Cell></Grid.Item>
        <Cell>{`${text(context).cell} 1`}</Cell>
        <Grid.Item span="full"><Cell>{text(context).full}</Cell></Grid.Item>
        <Cell>{`${text(context).cell} 2`}</Cell>
        <Cell>{`${text(context).cell} 3`}</Cell>
        <Cell>{`${text(context).cell} 4`}</Cell>
      </Grid>
    ),
  },
  {
    name: "Responsive columns (page container)",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <PageContainer gutter="none">
        <Grid columns={{ base: "1", wide: "main-aside" }} gap="md">
          <Cell>{text(context).main}</Cell>
          <Cell>{text(context).aside}</Cell>
        </Grid>
      </PageContainer>
    ),
  },
  {
    // ProjectDocumentMarkdownContent frontmatter: label and value columns on one baseline.
    name: "Label / value rows",
    render: () => (
      <Grid columns="1" gap="xs">
        {[["status", "draft"], ["owner", "mina"], ["updated", "2026-09-26"]].map(([label, value]) => (
          <Grid key={label} columns="label-value" gap="sm">
            <Typo.Caption tone="tertiary">{label}</Typo.Caption>
            <Typo.Caption tone="secondary" wrap="anywhere">{value}</Typo.Caption>
          </Grid>
        ))}
      </Grid>
    ),
  },
  {
    // Unbreakable content (a truncated path) in every preset: tracks shrink, the grid never widens.
    name: "Wide content (every preset)",
    widths: ["320", "375", "app"],
    render: () => (
      <Stack gap="md">
        {presetCells.map(([preset, count]) => (
          <Stack key={preset} gap="xs">
            <Typo.Caption tone="tertiary">{preset}</Typo.Caption>
            <Grid columns={preset} gap="xs">
              {Array.from({ length: count }, (_, index) => (
                <Grid.Item key={index}><Typo.Caption tone="secondary" truncate>{LONG_VALUE}</Typo.Caption></Grid.Item>
              ))}
            </Grid>
          </Stack>
        ))}
      </Stack>
    ),
  },
];
