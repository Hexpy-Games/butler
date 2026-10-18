import type { ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SpanAxis } from "./SpanAxis";
import { SpanBar, type SpanBarTone } from "./SpanBar";
import { GEMINI_TOTAL, GeminiTrace, formatTraceMs } from "./SpanBar.showcaseParts";

export const meta: ShowcaseMeta = {
  title: "SpanBar",
  category: "Inspector",
  tags: ["trace", "span", "timeline", "waterfall", "log", "duration"],
  status: "beta",
};

const labels = {
  "en-US": {
    default: "Leaf span", parent: "Parent span", muted: "App span", warning: "Waiting", danger: "Failed",
    tiny: "4ms of 7.11s (3px minimum)", clamped: "Runs past the trace (clamped)", end: "Zero length at the end",
  },
  "ko-KR": {
    default: "하위 구간", parent: "상위 구간", muted: "앱 구간", warning: "대기", danger: "실패",
    tiny: "7.11초 중 4ms (최소 3px)", clamped: "추적 끝을 넘음 (잘림)", end: "끝에서 길이 0",
  },
} as const;

const TONES: { tone: SpanBarTone; offset: number; duration: number }[] = [
  { tone: "default", offset: 2580, duration: 4370 },
  { tone: "parent", offset: 22, duration: 7090 },
  { tone: "muted", offset: 4, duration: 18 },
  { tone: "warning", offset: 580, duration: 2000 },
  { tone: "danger", offset: 168, duration: 412 },
];

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function Labelled({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <Stack gap="none">
      <Typo.Caption tone="secondary">{caption}</Typo.Caption>
      {children}
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Trace of a Gemini send",
    states: ["grow-in", "nested", "expanded"],
    render: (context) => <GeminiTrace locale={context.locale} />,
  },
  {
    name: "Tones",
    render: (context) => (
      <Stack gap="sm">
        <SpanAxis total={GEMINI_TOTAL} format={(ms) => formatTraceMs(context.locale, ms)} />
        {TONES.map(({ tone, offset, duration }, index) => (
          <Labelled key={tone} caption={text(context)[tone]}>
            <SpanBar offset={offset} duration={duration} total={GEMINI_TOTAL} tone={tone} index={index}
              label={`${text(context)[tone]}, ${formatTraceMs(context.locale, duration)}`} />
          </Labelled>
        ))}
      </Stack>
    ),
  },
  {
    name: "Edges",
    states: ["minimum width", "clamped"],
    render: (context) => (
      <Stack gap="sm">
        <Labelled caption={text(context).tiny}>
          <SpanBar offset={0} duration={4} total={GEMINI_TOTAL} label={text(context).tiny} />
        </Labelled>
        <Labelled caption={text(context).clamped}>
          <SpanBar offset={5200} duration={9000} total={GEMINI_TOTAL} tone="warning" label={text(context).clamped} />
        </Labelled>
        <Labelled caption={text(context).end}>
          <SpanBar offset={GEMINI_TOTAL} duration={0} total={GEMINI_TOTAL} tone="muted" label={text(context).end} />
        </Labelled>
      </Stack>
    ),
  },
  {
    name: "Axis with custom ticks",
    render: (context) => (
      <Stack gap="xs">
        <SpanAxis total={1840} ticks={[500, 1000, 1500]} format={(ms) => formatTraceMs(context.locale, ms)} />
        <SpanBar offset={120} duration={1480} total={1840} label={formatTraceMs(context.locale, 1480)} />
      </Stack>
    ),
  },
];
