import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../Card";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Grid } from "./Grid";

// #region recipe: Card grid with a wide item
function CardGrid() {
  return (
    <Grid columns="auto-fit" gap="md">
      <Card><Typo.Body>Open work</Typo.Body></Card>
      <Card><Typo.Body>Done this week</Typo.Body></Card>
      <Grid.Item span="full"><Card><Typo.Body>Activity calendar</Typo.Body></Card></Grid.Item>
    </Grid>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Two-dimensional layout with column presets, responsive columns and item spans.",
  whenToUse: ["A grid of cards or tiles that reflows by width", "Main and aside columns on a page"],
  whenNotToUse: [
    { when: "A single row or column", use: "Stack" },
    { when: "Metric cards", use: "MetricGrid" },
  ],
  recipes: [{ name: "Card grid with a wide item", description: "auto-fit fills columns; Grid.Item span=\"full\" takes a whole row.", render: () => <CardGrid /> }],
  doDont: [
    {
      do: { caption: "Presets (auto-fit, 2, 3, main-aside) keep grids consistent.", render: () => <CardGrid /> },
      dont: {
        caption: "A Stack of rows faking columns does not reflow.",
        render: () => <Stack gap="md"><Stack align="row" gap="md"><Card><Typo.Body>A</Typo.Body></Card><Card><Typo.Body>B</Typo.Body></Card></Stack></Stack>,
      },
    },
  ],
  content: ["columns=\"label-value\" lays out metadata rows: a label column and a baseline-aligned value.", "No copy of its own."],
  accessibility: ["Keep DOM order equal to reading order; spans never reorder content."],
  tokens: ["--space-md", "--layout-basis-sm", "--page-max-width-wide"],
};
