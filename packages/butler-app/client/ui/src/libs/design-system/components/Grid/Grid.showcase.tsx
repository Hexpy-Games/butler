import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Card } from "../Card";
import { Typo } from "../Typo";
import { Grid } from "./Grid";

export const meta: ShowcaseMeta = {
  title: "Grid",
  category: "Layout",
  tags: ["layout", "grid", "columns", "span"],
  status: "stable",
};

const labels = {
  "en-US": { cell: "Cell", wide: "Spans two columns", full: "Spans the full row" },
  "ko-KR": { cell: "셀", wide: "두 칸 차지", full: "한 줄 전체 차지" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

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
];
