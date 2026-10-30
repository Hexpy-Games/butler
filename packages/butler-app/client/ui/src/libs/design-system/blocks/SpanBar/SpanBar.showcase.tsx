import type { ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { SpanAxis } from "./SpanAxis";
import { SpanBar, type SpanBarTone } from "./SpanBar";
import { GeminiTrace, PlainIndentTrace, RowIndentTrace } from "./SpanBar.showcaseParts";
import { formatTraceMs, GEMINI_STEPS, GEMINI_TOTAL, stepChildren, stepTone } from "./SpanBar.showcaseData";

export const meta: ShowcaseMeta = {
  title: "SpanBar",
  category: "Inspector",
  tags: ["trace", "span", "timeline", "waterfall", "log", "duration", "segments"],
  status: "beta",
};

const labels = {
  "en-US": {
    model: "Model · HTTP request, stream", tool: "Tool · MCP call", app: "App side (send, deliver)",
    agent: "Agent work (turn, pick, context, memory)", error: "Error", wait: "Wait · retry · warning",
    turn: "Run turn: 8 direct steps", request: "Model request 1/3: one HTTP request",
    tiny: "4ms of 9.84s (3px minimum)", clamped: "Runs past the trace (clamped)", end: "Zero length at the end",
  },
  "ko-KR": {
    model: "모델 · HTTP 요청, 스트림", tool: "도구 · MCP 호출", app: "앱 쪽 단계 (보내기, 전달)",
    agent: "에이전트 작업 (턴, 선택, 컨텍스트, 기억)", error: "오류", wait: "대기 · 재시도 · 경고",
    turn: "턴 실행: 직접 단계 8개", request: "모델 요청 1/3: HTTP 요청 1개",
    tiny: "9.84초 중 4ms (최소 3px)", clamped: "추적 끝을 넘음 (잘림)", end: "끝에서 길이 0",
  },
} as const;

const TONES: SpanBarTone[] = ["model", "tool", "app", "agent", "error", "wait"];

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

/** A step's bar on the trace axis, split over its direct children. */
function StepBar({ id, caption, index }: { id: string; caption: string; index: number }) {
  const step = GEMINI_STEPS.find((candidate) => candidate.id === id)!;
  const segments = stepChildren(id).map((child) => ({ offset: child.offset, duration: child.duration, tone: stepTone(child) }));
  return (
    <Labelled caption={caption}>
      <SpanBar offset={step.offset} duration={step.duration} total={GEMINI_TOTAL} tone={stepTone(step)} segments={segments}
        index={index} label={caption} />
    </Labelled>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Trace of a Gemini send",
    states: ["grow-in", "segments", "text indent", "depth cue", "static rows", "expanded"],
    render: (context) => <GeminiTrace locale={context.locale} />,
  },
  {
    name: "Tones: solid and hatch",
    render: (context) => (
      <Stack gap="sm">
        {TONES.map((tone, index) => (
          <Labelled key={tone} caption={text(context)[tone]}>
            <SpanBar offset={0} duration={GEMINI_TOTAL} total={GEMINI_TOTAL} tone={tone} index={index}
              label={text(context)[tone]} />
            <SpanBar offset={0} duration={GEMINI_TOTAL} total={GEMINI_TOTAL} tone={tone} index={index}
              segments={[{ offset: 0, duration: GEMINI_TOTAL / 2, tone }, { offset: GEMINI_TOTAL / 2, duration: GEMINI_TOTAL / 2, tone }]} />
          </Labelled>
        ))}
      </Stack>
    ),
  },
  {
    name: "Segments",
    states: ["pattern", "parent time", "pill ends"],
    render: (context) => (
      <Stack gap="sm">
        <SpanAxis total={GEMINI_TOTAL} format={(ms) => formatTraceMs(context.locale, ms)} />
        <StepBar id="turn" caption={text(context).turn} index={0} />
        <StepBar id="req-1" caption={text(context).request} index={1} />
      </Stack>
    ),
  },
  {
    name: "Edges",
    states: ["minimum width", "clamped"],
    render: (context) => (
      <Stack gap="sm">
        <Labelled caption={text(context).tiny}>
          <SpanBar offset={0} duration={4} total={GEMINI_TOTAL} tone="app" label={text(context).tiny} />
        </Labelled>
        <Labelled caption={text(context).clamped}>
          <SpanBar offset={7200} duration={9000} total={GEMINI_TOTAL} tone="wait" label={text(context).clamped}
            segments={[{ offset: 7400, duration: 1000, tone: "error" }, { offset: 9000, duration: 4000, tone: "model" }]} />
        </Labelled>
        <Labelled caption={text(context).end}>
          <SpanBar offset={GEMINI_TOTAL} duration={0} total={GEMINI_TOTAL} tone="agent" label={text(context).end} />
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
  {
    name: "Text indent on plain rows",
    states: ["static", "interactive", "text indent", "depth cue"],
    render: (context) => <PlainIndentTrace locale={context.locale} />,
  },
  {
    name: "Row indent (chevron after the title)",
    render: (context) => <RowIndentTrace locale={context.locale} />,
  },
];
