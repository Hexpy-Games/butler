import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Grid } from "../Grid";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Box, type BoxBorder, type BoxSpace, type BoxSurface } from "./Box";

export const meta: ShowcaseMeta = {
  title: "Box",
  category: "Layout",
  tags: ["layout", "surface", "padding", "border", "radius"],
  status: "stable",
};

const labels = {
  "en-US": { content: "Content", surface: "surface", border: "border" },
  "ko-KR": { content: "내용", surface: "표면", border: "테두리" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const spaces: BoxSpace[] = ["none", "xs", "sm", "md", "lg", "xl", "2xl"];
const surfaces: BoxSurface[] = ["none", "base", "raised", "overlay", "muted"];
const borders: BoxBorder[] = ["none", "hairline", "strong"];

export const stories: ShowcaseStory[] = [
  {
    name: "Padding scale",
    render: (context) => (
      <Stack gap="sm">
        {spaces.map((space) => (
          <Box key={space} padding={space} border="hairline" radius="control">
            <Box surface="muted" radius="control" paddingX="sm">
              <Typo.Caption>{`padding="${space}" · ${text(context).content}`}</Typo.Caption>
            </Box>
          </Box>
        ))}
      </Stack>
    ),
  },
  {
    name: "Surfaces and borders",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <Grid columns="3" gap="sm">
        {surfaces.flatMap((surface) => borders.map((border) => (
          <Box key={`${surface}-${border}`} surface={surface} border={border} radius="panel" padding="md">
            <Typo.Caption tone="secondary">{`${text(context).surface}=${surface}`}</Typo.Caption>
            <Typo.Caption tone="secondary">{`${text(context).border}=${border}`}</Typo.Caption>
          </Box>
        )))}
      </Grid>
    ),
  },
  {
    name: "Radius",
    render: (context) => (
      <Stack align="row" gap="sm" wrap>
        {(["none", "control", "panel", "popover", "pill"] as const).map((radius) => (
          <Box key={radius} radius={radius} border="hairline" surface="raised" paddingX="md" paddingY="xs">
            <Typo.Caption>{`${radius} · ${text(context).content}`}</Typo.Caption>
          </Box>
        ))}
      </Stack>
    ),
  },
  {
    // TurnDecisionRow: an indented decision under the activity rail.
    name: "Inline-start padding (indented row)",
    render: () => (
      <Box as="article" paddingStart="2xl" border="hairline" radius="control" paddingY="sm">
        <Typo.Body>paddingStart indents one side only; the row keeps its full width.</Typo.Body>
      </Box>
    ),
  },
];
