import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { Grid } from "../../components/Grid";
import { PickStage } from "./PickOutline.demo";

export const meta: ShowcaseMeta = {
  title: "PickOutline",
  category: "Browser",
  tags: ["browser", "pick", "highlight", "outline", "hover", "selection", "overlay", "reduced motion"],
  status: "beta",
};

export const stories: ShowcaseStory[] = [
  {
    // The proposal's pick mode: two picks with their order, the next card under the pointer.
    name: "Hover and two picks",
    widths: ["app", "wide"],
    render: ({ locale }) => <PickStage locale={locale} picked={[0, 1]} hover={2} />,
  },
  {
    // Acceptance: the outline reads on white, black and photo pages (ink + white keylines, 3:1 tested).
    name: "Readable on white, black and photo pages",
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Grid columns="3" gap="md">
        <PickStage locale={locale} page="white" picked={[0]} hover={1} caption="white" />
        <PickStage locale={locale} page="black" picked={[0]} hover={1} caption="black" />
        <PickStage locale={locale} page="photo" picked={[0]} hover={1} caption="photo" />
      </Grid>
    ),
  },
  {
    // A hover at the page's top edge keeps its tag inside the outline; a pick at the edge keeps its badge.
    name: "At the page edge",
    render: ({ locale }) => <PickStage locale={locale} picked={[4, 0]} hover="header" />,
  },
  {
    name: "Picking, nothing picked yet",
    render: ({ locale }) => <PickStage locale={locale} picked={[]} hover={5} />,
  },
  {
    name: "Reduced motion: no fade or pop",
    render: ({ locale }) => <PickStage locale={locale} picked={[0, 1, 2]} hover={3} reducedMotion caption="reduced" />,
  },
];
