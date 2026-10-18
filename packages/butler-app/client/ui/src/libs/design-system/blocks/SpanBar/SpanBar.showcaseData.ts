import type { ShowcaseRenderContext } from "../../showcase";
import type { SpanBarTone } from "./SpanBar";

type Locale = ShowcaseRenderContext["locale"];
/** [en-US, ko-KR] */
type Copy = readonly [string, string];

export interface TraceStep {
  id: string;
  parent?: string;
  title: Copy;
  offset: number;
  duration: number;
  /** What the step is; error and wait (status) win over it for the fill. */
  kind: "model" | "tool" | "app" | "agent";
  problem?: "error" | "wait";
  tag?: { text: Copy; tone: "danger" | "warning" | "neutral" };
  facts?: ReadonlyArray<readonly [Copy, Copy]>;
}

const same = (text: string): Copy => [text, text];
const tag200 = { text: same("200"), tone: "neutral" } as const;
const tag429 = { text: same("429"), tone: "danger" } as const;

/** A Gemini send: 429 → retry wait → 200 with one tool call to a researcher sub-agent (depth 5). */
export const GEMINI_TOTAL = 9840;

export const GEMINI_STEPS: readonly TraceStep[] = [
  { id: "send", title: ["Send message", "메시지 보내기"], offset: 0, duration: 4, kind: "app" },
  { id: "deliver", title: ["Deliver", "전달"], offset: 4, duration: 18, kind: "app" },
  { id: "turn", title: ["Run turn", "턴 실행"], offset: 22, duration: 9818, kind: "agent",
    facts: [[["Turn ID", "턴 ID"], same("turn_01JB7Q4M2X")], [["Model", "모델"], same("Gemini 3 Pro")], [["Retries", "재시도"], ["1", "1회"]]] },
  { id: "route", parent: "turn", title: ["Pick model", "모델 선택"], offset: 30, duration: 6, kind: "agent",
    facts: [[same("gemini-3-pro"), ["Picked · default", "선택 · 기본 모델"]]] },
  { id: "context", parent: "turn", title: ["Build context", "컨텍스트 구성"], offset: 36, duration: 132, kind: "agent",
    facts: [[["Total", "합계"], ["14,050 tokens", "14,050 토큰"]]] },
  { id: "req-1", parent: "turn", title: ["Model request 1/3", "모델 요청 1/3"], offset: 168, duration: 412, kind: "model",
    problem: "error", tag: tag429,
    facts: [[["Result", "결과"], ["429 Rate limited", "429 요청 한도 초과"]], [["Next", "다음"], ["Retry in 2s", "2초 대기 후 재시도"]]] },
  { id: "http-1", parent: "req-1", title: ["HTTP request", "HTTP 요청"], offset: 170, duration: 408, kind: "model",
    problem: "error", tag: tag429, facts: [[["Request ID", "요청 ID"], same("9c1e0a7f2b4d")]] },
  { id: "wait-1", parent: "turn", title: ["Retry wait", "재시도 대기"], offset: 580, duration: 2000, kind: "agent",
    problem: "wait", tag: { text: ["Wait", "대기"], tone: "warning" },
    facts: [[same("retry-after"), ["2s", "2초"]], [["Policy", "정책"], ["Up to 3", "최대 3회"]], [["Reason", "이유"], same("RESOURCE_EXHAUSTED")]] },
  { id: "req-2", parent: "turn", title: ["Model request 2/3", "모델 요청 2/3"], offset: 2580, duration: 3150, kind: "model",
    tag: tag200, facts: [[["Attempt", "시도"], same("2/3")], [["Result", "결과"], ["200 · 1 tool call", "200 · 도구 호출 1개"]]] },
  { id: "http-2", parent: "req-2", title: ["HTTP request", "HTTP 요청"], offset: 2582, duration: 3146, kind: "model",
    tag: tag200, facts: [[["First byte", "첫 바이트"], ["1.08s", "1.08초"]]] },
  { id: "stream", parent: "http-2", title: ["Receive stream", "스트림 수신"], offset: 3662, duration: 2066, kind: "model",
    facts: [[["Chunks", "청크"], ["31", "31개"]]] },
  { id: "tool", parent: "turn", title: ["Tool call · ask_researcher", "도구 호출 · ask_researcher"], offset: 5740, duration: 3720,
    kind: "tool", facts: [[["Tool", "도구"], ["ask_researcher (sub-agent)", "ask_researcher (하위 에이전트)"]]] },
  { id: "sub-turn", parent: "tool", title: ["Sub-turn · Researcher", "하위 턴 실행 · 리서처"], offset: 5752, duration: 3690,
    kind: "agent", facts: [[["Model", "모델"], same("gpt-6-luna")]] },
  { id: "sub-req", parent: "sub-turn", title: ["Model request 1/3", "모델 요청 1/3"], offset: 5760, duration: 352,
    kind: "model", tag: tag200, facts: [[["Result", "결과"], ["Tool call docs.search", "도구 호출 docs.search"]]] },
  { id: "sub-tool", parent: "sub-turn", title: ["Tool call · docs.search", "도구 호출 · docs.search"], offset: 6120,
    duration: 2410, kind: "tool", facts: [[["Tool", "도구"], same("docs.search (MCP)")]] },
  { id: "mcp", parent: "sub-tool", title: ["MCP call · tools/call", "MCP 호출 · tools/call"], offset: 6126, duration: 2398,
    kind: "tool", facts: [[["Server", "서버"], same("docs")]] },
  { id: "mcp-http", parent: "mcp", title: same("MCP HTTP · POST /mcp"), offset: 6131, duration: 2380, kind: "tool",
    tag: tag200, facts: [[same("URL"), same("http://127.0.0.1:8931/mcp")], [["Response", "응답"], ["18.2 KB · 6 results", "18.2 KB · 결과 6개"]]] },
  { id: "sub-final", parent: "sub-turn", title: ["Model request (tool result)", "모델 요청 (도구 결과)"], offset: 8540,
    duration: 890, kind: "model", tag: tag200, facts: [[["Finish", "종료 이유"], same("stop")]] },
  { id: "final", parent: "turn", title: ["Model request (tool result)", "모델 요청 (도구 결과)"], offset: 9470, duration: 330,
    kind: "model", tag: tag200, facts: [[["Finish", "종료 이유"], same("STOP")]] },
  { id: "memory", parent: "turn", title: ["Save memory", "기억 저장"], offset: 9800, duration: 40, kind: "agent",
    facts: [[["Items", "항목"], ["2", "2개"]]] },
];

/** Rows open at first: the turn, the wait, the 200 attempt and the researcher sub-tree down to depth 5. */
export const GEMINI_OPEN = ["turn", "wait-1", "req-2", "tool", "sub-turn", "sub-tool", "mcp"];

export function copy(locale: Locale, text: Copy): string {
  return locale === "ko-KR" ? text[1] : text[0];
}

/** Status first (error red, wait amber), then the step's kind. */
export function stepTone(step: TraceStep): SpanBarTone {
  return step.problem ?? step.kind;
}

export function stepDepth(step: TraceStep): number {
  let depth = 0;
  for (let parent = step.parent; parent; parent = GEMINI_STEPS.find((candidate) => candidate.id === parent)?.parent) depth += 1;
  return depth;
}

export function stepChildren(id: string): TraceStep[] {
  return GEMINI_STEPS.filter((step) => step.parent === id);
}

/** "412ms" under a second, else "2.58초" / "2.58s"; whole seconds drop the decimals. */
export function formatTraceMs(locale: Locale, ms: number): string {
  if (ms > 0 && ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(2);
  return locale === "ko-KR" ? `${seconds}초` : `${seconds}s`;
}

export function startText(locale: Locale, offset: number): string {
  const seconds = (offset / 1000).toFixed(2);
  return locale === "ko-KR" ? `+${seconds}초` : `+${seconds}s`;
}
