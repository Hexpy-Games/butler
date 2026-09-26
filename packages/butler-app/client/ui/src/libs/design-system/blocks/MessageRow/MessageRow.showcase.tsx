import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Spinner } from "../../components/Spinner";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { useEnteringKeys } from "../../lib/useEnteringKeys";
import { MarkdownContent, useStreamingReveal } from "../MarkdownContent";
import { AssistantFooterSample, MESSAGE_FOOTER_LABELS, MessageTurnSample, UserFooterSample } from "./MessageRow.showcaseParts";
import { MessageRow, MessageStatusLabel, MessageStatusRow } from "./MessageRow";

export const meta: ShowcaseMeta = {
  title: "MessageRow",
  category: "Conversation & Activity",
  tags: ["message", "chat", "timeline", "motion", "streaming"],
  status: "stable",
};

const labels = {
  "en-US": {
    send: "Send",
    question: "Summarize the motion system.",
    summary: "Motion is short and decelerating on the way in, faster on the way out, and only a fade under reduced motion.",
    thinking: "Thinking",
    footer: MESSAGE_FOOTER_LABELS,
    answer: [
      "## Motion system",
      "",
      "Butler motion is **Linear-crisp**: short, decelerating entrances and faster exits.",
      "",
      "- Overlays fade and scale from their trigger.",
      "- Buttons press in on `--motion-instant`.",
      "- Streaming text fades in chunk by chunk without layout shifts.",
      "",
      "Reduced motion keeps every fade and drops the travel.",
    ].join("\n"),
  },
  "ko-KR": {
    send: "보내기",
    question: "모션 시스템을 요약해 줘.",
    summary: "모션은 들어올 때 짧게 감속하고 나갈 때 더 빠르며, 동작 줄이기에서는 페이드만 남습니다.",
    thinking: "생각하는 중",
    footer: { copy: "메시지 복사", copied: "복사됨", branchChat: "새 대화로 분기",
      branchProject: "프로젝트로 분기", completed: "응답 완료", workedFor: "9초 동안 작업" },
    answer: [
      "## 모션 시스템",
      "",
      "Butler 모션은 **Linear-crisp** 입니다. 짧고 감속하는 진입, 더 빠른 퇴장.",
      "",
      "- 오버레이는 트리거 위치에서 페이드와 스케일로 열립니다.",
      "- 버튼은 `--motion-instant` 로 눌립니다.",
      "- 스트리밍 텍스트는 레이아웃 이동 없이 조각마다 나타납니다.",
      "",
      "동작 줄이기 설정에서는 이동 없이 페이드만 남습니다.",
    ].join("\n"),
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Chunk cadence of the demo stream: 25 chunks/s. */
const CHUNK_INTERVAL_MS = 40;
const CHUNK_SIZE = 4;
const THINKING_MS = 900;

type Turn = { id: string; role: "user" | "assistant"; text: string; streaming: boolean; thinking: boolean; time: string };

function clockLabel(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** `?ds-stream-reveal=off` renders the stream without the chunk fade (perf control run). */
function streamRevealEnabled(): boolean {
  return typeof window === "undefined" || new URLSearchParams(window.location.search).get("ds-stream-reveal") !== "off";
}

function StreamingMarkdown({ value, streaming }: { value: string; streaming: boolean }) {
  const rehypePlugins = useStreamingReveal(value, streaming && streamRevealEnabled());
  return (
    <MarkdownContent data-ds-motion="stream">
      <ReactMarkdown rehypePlugins={rehypePlugins}>{value}</ReactMarkdown>
    </MarkdownContent>
  );
}

function SendAndStream({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [turns, setTurns] = useState<Turn[]>([]);
  const timers = useRef<number[]>([]);
  const entering = useEnteringKeys(turns.map((turn) => turn.id), "showcase");
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  const send = () => {
    const stamp = Date.now();
    const assistantId = `assistant-${stamp}`;
    setTurns((current) => [
      ...current.slice(-2),
      { id: `user-${stamp}`, role: "user", text: copy.question, streaming: false, thinking: false, time: clockLabel(new Date(stamp)) },
    ]);
    const schedule = (delay: number, run: () => void) => { timers.current.push(window.setTimeout(run, delay)); };
    schedule(160, () => setTurns((current) => [
      ...current,
      { id: assistantId, role: "assistant", text: "", streaming: true, thinking: true, time: clockLabel(new Date(stamp)) },
    ]));
    const total = Math.ceil(copy.answer.length / CHUNK_SIZE);
    for (let index = 1; index <= total; index += 1) {
      schedule(160 + THINKING_MS + index * CHUNK_INTERVAL_MS, () => setTurns((current) => current.map((turn) =>
        turn.id === assistantId
          ? { ...turn, thinking: false, text: copy.answer.slice(0, index * CHUNK_SIZE), streaming: index < total }
          : turn)));
    }
  };

  return (
    <Stack gap="md">
      <Button data-ds-motion="send" text={copy.send} onClick={send} />
      <div>
        {turns.map((turn) => turn.role === "user" ? (
          <MessageRow
            key={turn.id}
            role="user"
            entering={entering.has(turn.id)}
            footer={<UserFooterSample text={turn.text} time={turn.time} labels={copy.footer} />}
          >
            {turn.text}
          </MessageRow>
        ) : (
          <MessageRow key={turn.id} role="assistant" entering={entering.has(turn.id)}>
            {turn.thinking ? (
              <MessageStatusRow>
                <MessageStatusLabel mark={<Spinner size={14} />} shimmer>
                  <Typo.Body as="span">{copy.thinking}</Typo.Body>
                </MessageStatusLabel>
              </MessageStatusRow>
            ) : (
              <StreamingMarkdown value={turn.text} streaming={turn.streaming} />
            )}
            {!turn.thinking && !turn.streaming ? (
              <AssistantFooterSample text={turn.text} time={turn.time} labels={copy.footer} />
            ) : null}
          </MessageRow>
        ))}
      </div>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Default", render: (context) => <MessageTurnSample question={labels[context.locale].question} answer={labels[context.locale].summary} labels={labels[context.locale].footer} /> },
  {
    name: "Send and stream",
    states: ["enter", "streaming", "thinking"],
    widths: ["375", "app", "wide"],
    render: (context) => <SendAndStream context={context} />,
  },
];
