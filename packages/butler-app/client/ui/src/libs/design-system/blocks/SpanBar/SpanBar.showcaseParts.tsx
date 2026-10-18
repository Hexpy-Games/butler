import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { Inline } from "../../components/Inline";
import { Stack } from "../../components/Stack";
import { DisclosureRow } from "../DisclosureRow";
import { KeyValueRow } from "../KeyValueRow";
import { SpanAxis } from "./SpanAxis";
import { SpanBar, SpanRow, type SpanBarTone } from "./SpanBar";

type Locale = ShowcaseRenderContext["locale"];

interface TraceSpan {
  id: string;
  name: Record<Locale, string>;
  offset: number;
  duration: number;
  depth: number;
  tone: SpanBarTone;
  detail: Record<Locale, [string, string]>;
}

/** A Gemini send: one retry after a 503, then a streamed answer. */
export const GEMINI_TOTAL = 7112;

export const GEMINI_SPANS: TraceSpan[] = [
  { id: "send", name: { "en-US": "Send", "ko-KR": "전송" }, offset: 0, duration: 4, depth: 0, tone: "muted",
    detail: { "en-US": ["Origin", "App"], "ko-KR": ["출처", "앱"] } },
  { id: "deliver", name: { "en-US": "Deliver", "ko-KR": "전달" }, offset: 4, duration: 18, depth: 0, tone: "muted",
    detail: { "en-US": ["Queue", "Empty"], "ko-KR": ["대기열", "비어 있음"] } },
  { id: "turn", name: { "en-US": "Run turn", "ko-KR": "턴 실행" }, offset: 22, duration: 7090, depth: 0, tone: "parent",
    detail: { "en-US": ["Model", "Gemini 3 Pro"], "ko-KR": ["모델", "Gemini 3 Pro"] } },
  { id: "request-1", name: { "en-US": "Model request 1/3", "ko-KR": "모델 요청 1/3" }, offset: 168, duration: 412, depth: 1,
    tone: "danger", detail: { "en-US": ["Error", "503 Service unavailable"], "ko-KR": ["오류", "503 서비스 사용 불가"] } },
  { id: "retry-wait", name: { "en-US": "Retry wait", "ko-KR": "재시도 대기" }, offset: 580, duration: 2000, depth: 1,
    tone: "warning", detail: { "en-US": ["Reason", "Server busy"], "ko-KR": ["이유", "서버 혼잡"] } },
  { id: "request-2", name: { "en-US": "Model request 2/3", "ko-KR": "모델 요청 2/3" }, offset: 2580, duration: 4370, depth: 1,
    tone: "default", detail: { "en-US": ["Status", "200"], "ko-KR": ["상태", "200"] } },
  { id: "stream", name: { "en-US": "Receive stream", "ko-KR": "스트림 수신" }, offset: 3660, duration: 3290, depth: 2,
    tone: "default", detail: { "en-US": ["Chunks", "214"], "ko-KR": ["청크", "214개"] } },
  { id: "memory", name: { "en-US": "Save memory", "ko-KR": "기억 저장" }, offset: 6990, duration: 96, depth: 1,
    tone: "default", detail: { "en-US": ["Items", "2"], "ko-KR": ["항목", "2개"] } },
];

/** "0.58초" / "0.58s"; whole seconds drop the decimals ("0초", "2초"); under a second stays in ms. */
export function formatTraceMs(locale: Locale, ms: number, decimals = 2): string {
  if (ms > 0 && ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(decimals);
  return locale === "ko-KR" ? `${seconds}초` : `${seconds}s`;
}

function startText(locale: Locale, offset: number): string {
  const seconds = (offset / 1000).toFixed(2);
  return locale === "ko-KR" ? `+${seconds}초` : `+${seconds}s`;
}

function spokenText(locale: Locale, span: TraceSpan): string {
  const start = startText(locale, span.offset);
  const length = formatTraceMs(locale, span.duration);
  return locale === "ko-KR" ? `시작 ${start}, ${length}` : `Starts ${start}, ${length}`;
}

/** The trace page: the axis over DisclosureRows whose description carries the bar. */
export function GeminiTrace({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState<string | null>("request-1");
  const [round, setRound] = useState(0);
  return (
    <Stack gap="sm">
      <SpanAxis total={GEMINI_TOTAL} inset="disclosure" format={(ms) => formatTraceMs(locale, ms)} />
      <div key={round}>
        {GEMINI_SPANS.map((span, index) => (
          <SpanRow key={span.id} depth={span.depth}>
            <DisclosureRow title={span.name[locale]} meta={formatTraceMs(locale, span.duration)}
              open={open === span.id} controlsId={`span-${span.id}`}
              onToggle={() => setOpen((current) => (current === span.id ? null : span.id))}
              description={<>{startText(locale, span.offset)}
                <SpanBar offset={span.offset} duration={span.duration} total={GEMINI_TOTAL} tone={span.tone}
                  index={index} label={spokenText(locale, span)} /></>}>
              <KeyValueRow id={`span-${span.id}`} label={span.detail[locale][0]} value={span.detail[locale][1]}
                valueTextSize="caption" />
            </DisclosureRow>
          </SpanRow>
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
