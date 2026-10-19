import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { DisclosureRow } from "../DisclosureRow";
import { ProgressMeter } from "../ProgressMeter";
import { SpanAxis } from "./SpanAxis";
import { SpanBar, SpanRow, type SpanBarTone } from "./SpanBar";

const TOTAL = 9840;
const STEPS: Array<{ id: string; title: string; start: string; length: string; offset: number; duration: number;
  depth: number; tone: SpanBarTone; count?: number }> = [
  { id: "turn", title: "Run turn", start: "+0.02s", length: "9.82s", offset: 22, duration: 9818, depth: 0, tone: "agent", count: 2 },
  { id: "request", title: "Model request 1/3", start: "+0.17s", length: "412ms", offset: 168, duration: 412, depth: 1, tone: "error" },
  { id: "wait", title: "Retry wait", start: "+0.58s", length: "2s", offset: 580, duration: 2000, depth: 1, tone: "wait" },
];
const SEGMENTS = STEPS.slice(1).map(({ offset, duration, tone }) => ({ offset, duration, tone }));

// #region recipe: Trace steps on one axis
function TraceSteps() {
  return (
    <Stack gap="sm">
      <SpanAxis total={TOTAL} inset="row" />
      <div>
        {STEPS.map((step, index) => (
          <SpanRow key={step.id} depth={step.depth} indent="text" depthLabel={(depth) => `Depth ${depth}`}>
            <DisclosureRow affordance="none" title={step.title} count={step.count} meta={step.length} description={step.start}
              attention={step.tone === "error" ? "error" : step.tone === "wait" ? "warning" : undefined}
              bar={<SpanBar offset={step.offset} duration={step.duration} total={TOTAL} tone={step.tone} index={index}
                segments={step.count ? SEGMENTS : undefined} label={`Starts ${step.start}, ${step.length}`} />} />
          </SpanRow>
        ))}
      </div>
    </Stack>
  );
}
// #endregion

// #region recipe: A single span under a caption
function SingleSpan() {
  return <SpanBar offset={580} duration={2000} total={TOTAL} tone="wait" label="Starts +0.58s, 2s" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One span of a trace on the trace's shared time axis: a bar placed by its start offset and sized by its duration, in a trace tone, optionally split over its direct children; SpanAxis labels the axis and SpanRow places a row at its nesting depth.",
  whenToUse: [
    "A request trace or log waterfall: when each step started and how long it took",
    "Showing what a parent step spent its time on (segments: one per direct child)",
  ],
  whenNotToUse: [
    { when: "A fraction of a budget or a task's progress", use: "ProgressMeter" },
    { when: "Usage totals per day or hour", use: "UsageBars" },
    { when: "Which days something changed", use: "ActivityStrip" },
  ],
  recipes: [
    { name: "Trace steps on one axis", description: "SpanAxis inset=row over text-indent SpanRows; each DisclosureRow (affordance none) carries its SpanBar in `bar`, with segments for a parent.", render: () => <TraceSteps /> },
    { name: "A single span under a caption", description: "Pass the same total to every bar of a trace.", render: () => <SingleSpan /> },
  ],
  doDont: [
    {
      do: { caption: "Every bar of a trace shares one total and one axis.", render: () => <TraceSteps /> },
      dont: { caption: "A progress meter per step: each starts at 0, so start times are lost.", render: () => <ProgressMeter bare ariaLabel="Retry wait" value={28} /> },
    },
  ],
  content: [
    "Row title: the step in a few words (턴 실행, 모델 요청 1/3). Meta: the duration, with a status Tag (429, 대기). Description: the start offset (+0.58초).",
    "label speaks start and length: \"시작 +0.58초, 2초\" / \"Starts +0.58s, 2s\".",
    "SpanAxis format matches the row copy (2초 / 2s); the last tick is the trace total.",
    "Tone: status first (error, wait), then the step's kind: model (model and HTTP requests, streams), tool (tool and MCP calls), app (send, deliver), agent (turn, pick model, context, memory).",
    "Segments: one per direct child, in trace time; the parent's own uncovered time keeps the parent's tone. Draw the same segments open or closed.",
  ],
  accessibility: [
    "The track is aria-hidden; label renders as visually hidden text, so inside a DisclosureRow it joins the row's accessible name.",
    "Tone never carries meaning alone: the row title or meta names the failure or the wait; the hatch separates neighbours without color.",
    "SpanAxis is aria-hidden; each bar speaks its own start and length.",
    "Text indent keeps every bar on the full width; deeper than 3 levels the row says its depth (depthLabel) instead of indenting further.",
    "Reduced motion (app setting or OS) fades the bars in instead of growing them.",
  ],
  tokens: [
    "--trace-model", "--trace-tool", "--trace-app", "--trace-agent", "--trace-error", "--trace-wait", "--trace-model-alt", "--trace-wait-alt",
    "--selection", "--radius-pill", "--motion-deliberate", "--motion-ease-decelerate", "--motion-stagger-row", "--space-lg",
    "--typo-caption-line-height",
  ],
};
