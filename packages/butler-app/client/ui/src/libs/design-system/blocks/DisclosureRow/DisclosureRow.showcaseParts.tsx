import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Inline } from "../../components/Inline";
import { Stack } from "../../components/Stack";
import { Tag, type TagTone } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { KeyValueRow } from "../KeyValueRow";
import { DisclosureRow } from "./DisclosureRow";

type Locale = ShowcaseRenderContext["locale"];
type Copy = readonly [string, string];

const pick = (locale: Locale, text: Copy) => (locale === "ko-KR" ? text[1] : text[0]);

interface LogRecord {
  id: string;
  title: Copy;
  level: { text: Copy; tone: TagTone };
  duration?: string;
  description: Copy;
  facts: ReadonlyArray<readonly [Copy, string]>;
}

const LOGS: readonly LogRecord[] = [
  { id: "log_9f21", title: ["Send failed · 429 rate limited", "메시지 보내기 실패 · 429 요청 한도 초과"],
    level: { text: ["Error", "오류"], tone: "danger" }, duration: "7.40s",
    description: ["14:06:19 · Model · Agent", "14:06:19 · 모델 · 에이전트"],
    facts: [[["Model", "모델"], "Gemini 3 Pro"], [["Attempts", "시도"], "3/3"], [["Trace ID", "추적 ID"], "tr_01JB7R0C5K"]] },
  { id: "log_9e52", title: ["Retrying after 429 · retry-after 2s", "429 후 재시도 · retry-after 2초"],
    level: { text: ["Warning", "경고"], tone: "warning" },
    description: ["14:02:31 · Model · Agent", "14:02:31 · 모델 · 에이전트"],
    facts: [[["Policy", "정책"], "3"], [["Reason", "이유"], "RESOURCE_EXHAUSTED"]] },
  { id: "log_9d10", title: ["Schedule ran · Weekly notes", "예약 작업 실행 · 주간 회의 정리"],
    level: { text: ["Info", "정보"], tone: "neutral" }, duration: "12.1s",
    description: ["14:00:00 · Schedule · Agent", "14:00:00 · 예약 작업 · 에이전트"],
    facts: [[["Result", "결과"], "OK"]] },
];

/** A log list: chevrons right after the title turn down when a record opens; the title starts at the row inset. */
export function LogList({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState<string | null>("log_9e52");
  return (
    <Stack gap="none">
      {LOGS.map((record) => (
        <DisclosureRow key={record.id} title={pick(locale, record.title)}
          description={pick(locale, record.description)} open={open === record.id} controlsId={`log-${record.id}`}
          onToggle={() => setOpen((current) => (current === record.id ? null : record.id))}
          meta={(
            <Inline as="span" gap="xs" wrap={false}>
              <Tag size="sm" tone={record.level.tone}>{pick(locale, record.level.text)}</Tag>
              {record.duration ? <Typo.Caption tone="tertiary" numeric="tabular">{record.duration}</Typo.Caption> : null}
            </Inline>
          )}>
          <Stack id={`log-${record.id}`} gap="xs">
            <KeyValueRow label="ID" value={record.id} valueTextSize="caption" />
            {record.facts.map(([label, value]) => (
              <KeyValueRow key={label[0]} label={pick(locale, label)} value={value} valueTextSize="caption" />
            ))}
          </Stack>
        </DisclosureRow>
      ))}
    </Stack>
  );
}

const STEPS = {
  turn: ["Run turn", "턴 실행"], request: ["Model request 1/3", "모델 요청 1/3"], wait: ["Retry wait", "재시도 대기"],
  send: ["Send message", "메시지 보내기"], deliver: ["Deliver", "전달"], status: ["Status", "상태"],
} as const satisfies Record<string, Copy>;

/**
 * Trace steps: no chevron. Rows with something to reveal are buttons (count,
 * problem dot); rows with nothing hidden are static with the same columns.
 */
export function TraceSteps({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState<string | null>("request");
  const toggle = (id: string) => () => setOpen((current) => (current === id ? null : id));
  const t = (text: Copy) => pick(locale, text);
  return (
    <Stack gap="none">
      <DisclosureRow affordance="none" title={t(STEPS.send)} meta="4ms" description="+0.00s" />
      <DisclosureRow affordance="none" title={t(STEPS.deliver)} meta="18ms" description="+0.00s" />
      <DisclosureRow affordance="none" title={t(STEPS.turn)} count={8} meta="9.82s" description="+0.02s"
        open={open === "turn"} onToggle={toggle("turn")} />
      <DisclosureRow affordance="none" attention="error" title={t(STEPS.request)} count={1} description="+0.17s"
        meta={<Inline as="span" gap="xs" wrap={false}><Tag size="sm" tone="danger">429</Tag><Typo.Caption tone="tertiary">412ms</Typo.Caption></Inline>}
        open={open === "request"} onToggle={toggle("request")} controlsId="step-request">
        <KeyValueRow id="step-request" label={t(STEPS.status)} value="429" valueTextSize="caption" />
      </DisclosureRow>
      <DisclosureRow affordance="none" attention="warning" title={t(STEPS.wait)} description="+0.58s"
        meta={<Inline as="span" gap="xs" wrap={false}><Tag size="sm" tone="warning">{locale === "ko-KR" ? "대기" : "Wait"}</Tag><Typo.Caption tone="tertiary">2s</Typo.Caption></Inline>}
        open={open === "wait"} onToggle={toggle("wait")} controlsId="step-wait">
        <KeyValueRow id="step-wait" label="retry-after" value="2s" valueTextSize="caption" />
      </DisclosureRow>
    </Stack>
  );
}
