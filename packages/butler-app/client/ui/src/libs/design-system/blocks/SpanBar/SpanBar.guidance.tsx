import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { DisclosureRow } from "../DisclosureRow";
import { ProgressMeter } from "../ProgressMeter";
import { SpanAxis } from "./SpanAxis";
import { SpanBar, SpanRow } from "./SpanBar";

const TRACE = [
  { id: "turn", title: "Run turn", start: "+0.02s", length: "7.09s", offset: 22, duration: 7090, depth: 0, tone: "parent" },
  { id: "request", title: "Model request 1/3", start: "+0.17s", length: "412ms", offset: 168, duration: 412, depth: 1, tone: "danger" },
  { id: "wait", title: "Retry wait", start: "+0.58s", length: "2s", offset: 580, duration: 2000, depth: 1, tone: "warning" },
] as const;

// #region recipe: Trace rows on one axis
function TraceRows() {
  return (
    <Stack gap="sm">
      <SpanAxis total={7112} inset="disclosure" maxDepth={1} />
      <div>
        {TRACE.map((span, index) => (
          <SpanRow key={span.id} depth={span.depth} maxDepth={1}>
            <DisclosureRow title={span.title} meta={span.length}
              description={<>{span.start}<SpanBar offset={span.offset} duration={span.duration} total={7112}
                tone={span.tone} index={index} label={`Starts ${span.start}, ${span.length}`} /></>} />
          </SpanRow>
        ))}
      </div>
    </Stack>
  );
}
// #endregion

// #region recipe: A single span under a caption
function SingleSpan() {
  return <SpanBar offset={580} duration={2000} total={7112} tone="warning" label="Starts +0.58s, 2s" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One span of a trace on the trace's shared time axis: a bar placed by its start offset and sized by its duration, with a status tone; SpanAxis labels the axis and SpanRow indents a row by nesting depth.",
  whenToUse: [
    "A request trace or log waterfall: when each step started and how long it took",
    "Comparing step durations inside one run (retries, waits, streaming)",
  ],
  whenNotToUse: [
    { when: "A fraction of a budget or a task's progress", use: "ProgressMeter" },
    { when: "Usage totals per day or hour", use: "UsageBars" },
    { when: "Which days something changed", use: "ActivityStrip" },
  ],
  recipes: [
    { name: "Trace rows on one axis", description: "SpanAxis inset=disclosure over SpanRows, all given the trace's maxDepth; each DisclosureRow description holds the start text and the SpanBar.", render: () => <TraceRows /> },
    { name: "A single span under a caption", description: "Pass the same total to every bar of a trace.", render: () => <SingleSpan /> },
  ],
  doDont: [
    {
      do: { caption: "Every bar of a trace shares one total and one axis.", render: () => <TraceRows /> },
      dont: { caption: "A progress meter per step: each starts at 0, so start times are lost.", render: () => <ProgressMeter bare ariaLabel="Retry wait" value={28} /> },
    },
  ],
  content: [
    "Row title: the step in a few words (전송, 모델 요청 1/3). Meta: the duration. Description: the start offset (+0.58초).",
    "label speaks start and length: \"시작 +0.58초, 2.00초\" / \"Starts +0.58s, 2s\".",
    "SpanAxis format matches the row copy (2초 / 2s); the last tick is the trace total.",
    "Tones: parent for a span with children, danger for a failed step, warning for a wait or retry, muted for app-side hops.",
  ],
  accessibility: [
    "The track is aria-hidden; label renders as visually hidden text, so inside a DisclosureRow it joins the row's accessible name.",
    "Tone never carries meaning alone: the row title or meta names the failure or the wait.",
    "SpanAxis is aria-hidden; each bar speaks its own start and length.",
    "Bars stay inside their row's hover and open fill at any depth (pass maxDepth), so focus rings and fills are never crossed.",
    "Reduced motion (app setting or OS) fades the bars in instead of growing them.",
  ],
  tokens: [
    "--accent", "--line-strong", "--color-danger", "--color-warning", "--selection", "--radius-pill",
    "--motion-deliberate", "--motion-ease-decelerate", "--motion-stagger-row", "--space-lg", "--typo-caption-line-height",
  ],
};
