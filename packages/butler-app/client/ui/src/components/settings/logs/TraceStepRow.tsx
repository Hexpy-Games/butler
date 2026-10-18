import { appCopy } from "@/app/copy.ts";
import { DisclosureRow, Inline, SpanBar, SpanRow, Tag, Typo } from "@/butler-ds";
import type { TraceView } from "./traceApi";
import { TraceStepDetail, hasStepDetail } from "./TraceStepDetail";
import { stepAttention, stepTone, type TraceStep } from "./traceModel";
import { formatTraceMs, formatTraceStart, stepTag, stepTitle } from "./traceText";

interface TraceStepRowProps {
  trace: TraceView;
  step: TraceStep;
  total: number;
  index: number;
  open: boolean;
  onToggle: () => void;
}

/**
 * One step: no chevron; a count and a problem dot by the title; a bar on the
 * shared axis, split into its direct children's pieces. A row with nothing
 * to reveal is static.
 */
export function TraceStepRow({ trace, step, total, index, open, onToggle }: TraceStepRowProps) {
  const copy = appCopy.settings.logs.trace;
  const detail = hasStepDetail(step, trace);
  const panelId = `trace-step-${step.id}`;
  const start = formatTraceStart(step.offset);
  const length = formatTraceMs(step.duration);
  return (
    <SpanRow depth={step.depth} indent="text" depthLabel={copy.depth} data-test-class="trace-step"
      data-step-name={step.span.name} data-span-id={step.id}>
      <DisclosureRow affordance="none" title={stepTitle(step)} count={step.children.length || undefined}
        attention={stepAttention(step)} meta={<StepMeta step={step} length={length} />} description={start}
        open={open} onToggle={onToggle} controlsId={detail ? panelId : undefined}
        bar={<SpanBar offset={step.offset} duration={step.duration} total={total} tone={stepTone(step)} index={index}
          segments={step.children.map((child) => ({ offset: child.offset, duration: child.duration, tone: stepTone(child) }))}
          label={copy.spoken(start, length)} />}>
        {detail ? <TraceStepDetail id={panelId} trace={trace} step={step} open={open} /> : null}
      </DisclosureRow>
    </SpanRow>
  );
}

/** Trailing meta: a status Tag where it says something (429, 대기, 200), then the length. */
function StepMeta({ step, length }: { step: TraceStep; length: string }) {
  const tag = stepTag(step);
  return (
    <Inline as="span" gap="xs" cross="center" wrap={false}>
      {tag ? <Tag size="sm" tone={tag.tone}>{tag.text}</Tag> : null}
      <Typo.Caption as="span" tone="tertiary" numeric="tabular">{length}</Typo.Caption>
    </Inline>
  );
}
