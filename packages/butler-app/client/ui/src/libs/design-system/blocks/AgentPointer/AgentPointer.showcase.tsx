import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { Grid } from "../../components/Grid";
import { MotionLab, PointerStage } from "./AgentPointer.demo";
import { FrameStrip, MOTIONS } from "./AgentPointer.frames";
import type { AgentPointerMode } from "./AgentPointer";

export const meta: ShowcaseMeta = {
  title: "AgentPointer",
  category: "Browser",
  tags: ["browser", "pointer", "cursor", "overlay", "agent", "riso", "reduced motion", "glide", "curve"],
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
  { name: "Motion lab: curved glide, retarget mid-glide, whole page", states: ["moving"], render: ({ locale }) => <MotionLab locale={locale} /> },
  { name: "Motion lab, reduced motion: jumps, rings without fades", render: ({ locale }) => <MotionLab locale={locale} reducedMotion /> },
  // Frame strips: each frame replays the motion and holds it at the time below it.
  { name: "Frames: a ring appears in place (fade only)", widths: ["app", "wide"], render: ({ locale }) => <FrameStrip locale={locale} motion={MOTIONS.ringAppear} /> },
  { name: "Frames: target change (old ring fades where it was, new ring fades in)", widths: ["app", "wide"], render: ({ locale }) => <FrameStrip locale={locale} motion={MOTIONS.targetChange} /> },
  { name: "Frames: whole-page target (no ring; the page edge shows it)", widths: ["app", "wide"], render: ({ locale }) => <FrameStrip locale={locale} motion={MOTIONS.wholePage} /> },
  { name: "Frames: curved glide (400ms)", widths: ["app", "wide"], render: ({ locale }) => <FrameStrip locale={locale} motion={MOTIONS.curvedGlide} /> },
  { name: "Frames: retarget at 160ms (continues from the drawn position)", widths: ["app", "wide"], render: ({ locale }) => <FrameStrip locale={locale} motion={MOTIONS.interrupted} /> },
  { name: "Frames: batch steps follow the path through the stops", widths: ["app", "wide"], render: ({ locale }) => <FrameStrip locale={locale} motion={MOTIONS.batch} /> },
  { name: "Frames: reduced motion (jumps, no fades)", widths: ["app", "wide"], render: ({ locale }) => <FrameStrip locale={locale} motion={MOTIONS.targetChange} reducedMotion /> },
  {
    name: "Reduced motion: no glide, trail or ripple",
    render: ({ locale }) => <PointerStage locale={locale} mode="click" reducedMotion caption="reduced" />,
  },
];
