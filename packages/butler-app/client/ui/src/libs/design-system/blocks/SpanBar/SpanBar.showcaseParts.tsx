import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { Inline } from "../../components/Inline";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { DisclosureRow } from "../DisclosureRow";
import { KeyValueRow } from "../KeyValueRow";
import { SpanAxis } from "./SpanAxis";
import { SpanBar, SpanRow } from "./SpanBar";
import {
  copy, formatTraceMs, GEMINI_OPEN, GEMINI_STEPS, GEMINI_TOTAL, startText, stepChildren, stepDepth, stepTone,
  type TraceStep,
} from "./SpanBar.showcaseData";

type Locale = ShowcaseRenderContext["locale"];

/** Trailing meta: an optional status Tag beside the length; never truncated. */
export function StepMeta({ locale, step }: { locale: Locale; step: TraceStep }) {
  return (
    <Inline as="span" gap="xs" wrap={false}>
      {step.tag ? <Tag size="sm" tone={step.tag.tone}>{copy(locale, step.tag.text)}</Tag> : null}
      <Typo.Caption tone="tertiary" numeric="tabular">{formatTraceMs(locale, step.duration)}</Typo.Caption>
    </Inline>
  );
}

function spoken(locale: Locale, step: TraceStep): string {
  const start = startText(locale, step.offset);
  const length = formatTraceMs(locale, step.duration);
  return locale === "ko-KR" ? `시작 ${start}, ${length}` : `Starts ${start}, ${length}`;
}

/** One trace step: no chevron, count and problem dot by the title, a segmented bar over its children. */
export function TraceStepRow({ locale, step, index, open, onToggle }: {
  locale: Locale; step: TraceStep; index: number; open: boolean; onToggle: () => void;
}) {
  const children = stepChildren(step.id);
  const attention = step.problem === "error" ? "error" : step.problem === "wait" ? "warning" : undefined;
  return (
    <SpanRow depth={stepDepth(step)} indent="text"
      depthLabel={(depth) => (locale === "ko-KR" ? `깊이 ${depth}` : `Depth ${depth}`)}>
      <DisclosureRow affordance="none" title={copy(locale, step.title)} count={children.length || undefined}
        attention={attention} meta={<StepMeta locale={locale} step={step} />} description={startText(locale, step.offset)}
        open={open} onToggle={onToggle} controlsId={step.facts ? `trace-${step.id}` : undefined}
        bar={<SpanBar offset={step.offset} duration={step.duration} total={GEMINI_TOTAL} tone={stepTone(step)} index={index}
          segments={children.map((child) => ({ offset: child.offset, duration: child.duration, tone: stepTone(child) }))}
          label={spoken(locale, step)} />}>
        {step.facts ? (
          <Stack gap="xs" id={`trace-${step.id}`}>
            {step.facts.map(([label, value]) => (
              <KeyValueRow key={label[0]} label={copy(locale, label)} value={copy(locale, value)} valueTextSize="caption" />
            ))}
          </Stack>
        ) : null}
      </DisclosureRow>
    </SpanRow>
  );
}

/** The trace page: the axis over trace steps; a parent shows its child steps while open. */
export function GeminiTrace({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState(() => new Set(GEMINI_OPEN));
  const [round, setRound] = useState(0);
  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const visible = GEMINI_STEPS.filter((step) => {
    for (let parent = step.parent; parent; parent = GEMINI_STEPS.find((candidate) => candidate.id === parent)?.parent) {
      if (!open.has(parent)) return false;
    }
    return true;
  });
  return (
    <Stack gap="sm">
      <SpanAxis total={GEMINI_TOTAL} inset="row" format={(ms) => formatTraceMs(locale, ms)} />
      <div key={round}>
        {visible.map((step, index) => (
          <TraceStepRow key={step.id} locale={locale} step={step} index={index} open={open.has(step.id)}
            onToggle={() => toggle(step.id)} />
        ))}
      </div>
      <Inline>
        <Button size="sm" variant="outline" data-ds-motion="replay" onClick={() => setRound((current) => current + 1)}>
          {locale === "ko-KR" ? "다시 재생" : "Replay"}
        </Button>
      </Inline>
    </Stack>
  );
}

/** Row indent (chevron after the title): the whole row indents and its bar lines up with the shared axis. */
export function RowIndentTrace({ locale }: { locale: Locale }) {
  const steps = GEMINI_STEPS.filter((step) => ["turn", "req-2", "http-2", "stream"].includes(step.id));
  const maxDepth = Math.max(...steps.map(stepDepth));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Stack gap="sm">
      <SpanAxis total={GEMINI_TOTAL} inset="disclosure" maxDepth={maxDepth} format={(ms) => formatTraceMs(locale, ms)} />
      <div>
        {steps.map((step, index) => (
          <SpanRow key={step.id} depth={stepDepth(step)} maxDepth={maxDepth}>
            <DisclosureRow title={copy(locale, step.title)} meta={formatTraceMs(locale, step.duration)}
              open={open === step.id} onToggle={() => setOpen((current) => (current === step.id ? null : step.id))}
              description={<>{startText(locale, step.offset)}
                <SpanBar offset={step.offset} duration={step.duration} total={GEMINI_TOTAL} tone={stepTone(step)}
                  index={index} label={spoken(locale, step)} /></>}>
              <KeyValueRow label={copy(locale, step.facts![0]![0])} value={copy(locale, step.facts![0]![1])}
                valueTextSize="caption" />
            </DisclosureRow>
          </SpanRow>
        ))}
      </div>
    </Stack>
  );
}

/** Plain rows in text-indent SpanRows: static and interactive rows keep the 8px start inset at every depth. */
export function PlainIndentTrace({ locale }: { locale: Locale }) {
  const steps = [0, 1, 2, 3, 4].map((depth) => GEMINI_STEPS.find((step) => stepDepth(step) === depth)).filter((step) => step !== undefined);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Stack gap="sm">
      <SpanAxis total={GEMINI_TOTAL} inset="row" format={(ms) => formatTraceMs(locale, ms)} />
      <div>
        {steps.flatMap((step, index) => [true, false].map((interactive) => (
          <SpanRow key={`${step.id}-${interactive}`} depth={stepDepth(step)} indent="text"
            depthLabel={(depth) => (locale === "ko-KR" ? `깊이 ${depth}` : `Depth ${depth}`)}>
            <DisclosureRow surface="plain" affordance="none" title={copy(locale, step.title)}
              count={interactive ? stepChildren(step.id).length || 1 : undefined}
              meta={formatTraceMs(locale, step.duration)} description={startText(locale, step.offset)}
              open={open === step.id && interactive} onToggle={() => setOpen((current) => (current === step.id ? null : step.id))}
              bar={<SpanBar offset={step.offset} duration={step.duration} total={GEMINI_TOTAL} tone={stepTone(step)}
                index={index} label={spoken(locale, step)} />} />
          </SpanRow>
        )))}
      </div>
    </Stack>
  );
}
