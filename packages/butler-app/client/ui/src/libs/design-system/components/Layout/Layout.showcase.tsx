import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Grid } from "../Grid";
import { Stack } from "../Stack";
import { Tag } from "../Tag";
import { Typo } from "../Typo";

export const meta: ShowcaseMeta = {
  title: "Layout",
  category: "Layout",
  tags: ["layout", "item-props", "grow", "basis", "span"],
  status: "stable",
};

const labels = {
  "en-US": { label: "Provider usage and remaining quota for this month", total: "12,480", xs: "xs", sm: "sm", md: "md", lg: "lg" },
  "ko-KR": { label: "이번 달 제공자별 사용량과 남은 한도", total: "12,480", xs: "xs", sm: "sm", md: "md", lg: "lg" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Basis scale",
    render: (context) => (
      <Stack gap="xs">
        {(["xs", "sm", "md", "lg"] as const).map((size) => (
          <Stack align="row" key={size}>
            <Stack.Item basis={size} shrink={false}><Tag>{`basis=${text(context)[size]}`}</Tag></Stack.Item>
          </Stack>
        ))}
      </Stack>
    ),
  },
  {
    name: "Label and value row",
    widths: ["320", "375", "app"],
    render: (context) => (
      <Stack align="row" justify="between" cross="start" gap="md" wrap>
        <Typo.Body grow basis="md" minWidth="0">{text(context).label}</Typo.Body>
        <Typo.Body align="end" numeric="tabular" wrap="nowrap">{text(context).total}</Typo.Body>
      </Stack>
    ),
  },
  {
    name: "Align self and span",
    render: (context) => (
      <Grid columns="2" gap="sm">
        <Grid.Item span="full"><Tag>span=full</Tag></Grid.Item>
        <Grid.Item alignSelf="end"><Tag>alignSelf=end</Tag></Grid.Item>
        <Typo.Body>{text(context).label}</Typo.Body>
      </Grid>
    ),
  },
  {
    // SpaceRowMeta: the status never takes more than three fifths of the meta line.
    name: "Capped item width",
    render: () => (
      <Stack align="row" cross="baseline" justify="between" gap="sm">
        <Typo.Caption tone="secondary" grow basis="0" minWidth="0" truncate>projects/butler-site/specs/design-system.md</Typo.Caption>
        <Typo.Caption tone="secondary" maxWidth="3/5" truncate>Working on the settings hierarchy and every page</Typo.Caption>
      </Stack>
    ),
  },
];
