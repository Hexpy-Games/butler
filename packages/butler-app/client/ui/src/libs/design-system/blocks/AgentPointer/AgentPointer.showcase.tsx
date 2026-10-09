import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { Grid } from "../../components/Grid";
import { GlideDemo, PointerStage } from "./AgentPointer.demo";
import type { AgentPointerMode } from "./AgentPointer";

export const meta: ShowcaseMeta = {
  title: "AgentPointer",
  category: "Browser",
  tags: ["browser", "pointer", "cursor", "overlay", "agent", "riso", "reduced motion"],
  status: "beta",
};

const MODES: AgentPointerMode[] = ["observe", "click", "type", "scroll", "batch", "parked"];

export const stories: ShowcaseStory[] = [
  {
    name: "Modes",
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Grid columns="2" gap="md">
        {MODES.map((mode) => <PointerStage key={mode} locale={locale} mode={mode} caption={mode} />)}
      </Grid>
    ),
  },
  {
    // Acceptance: the outline reads on white, black and photo pages (halo + keyline, 3:1 tested).
    name: "Readable on white, black and photo pages",
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Grid columns="3" gap="md">
        <PointerStage locale={locale} mode="click" page="white" caption="white" />
        <PointerStage locale={locale} mode="click" page="black" caption="black" />
        <PointerStage locale={locale} mode="click" page="photo" caption="photo" />
      </Grid>
    ),
  },
  {
    name: "Waiting tones (parked)",
    render: ({ locale }) => (
      <Grid columns="2" gap="md">
        <PointerStage locale={locale} mode="parked" tone="waiting" caption="waiting" />
        <PointerStage locale={locale} mode="parked" tone="need-input" caption="need-input" />
      </Grid>
    ),
  },
  { name: "Glide between targets (400ms)", states: ["moving"], render: ({ locale }) => <GlideDemo locale={locale} /> },
  {
    name: "Reduced motion: no glide, trail or ripple",
    render: ({ locale }) => <PointerStage locale={locale} mode="click" reducedMotion caption="reduced" />,
  },
];
