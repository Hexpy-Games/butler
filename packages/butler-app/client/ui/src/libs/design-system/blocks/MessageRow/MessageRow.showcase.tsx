import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { CopyButton } from "../../components/CopyButton";
import { Spinner } from "../../components/Spinner";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { useEnteringKeys } from "../../lib/useEnteringKeys";
import { MarkdownContent, useStreamingReveal } from "../MarkdownContent";
import { MessageRowFixture } from "./MessageRow.fixtures";
import { MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow } from "./MessageRow";

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
    thinking: "Thinking",
    copy: "Copy message",
    copied: "Copied",
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
    thinking: "생각하는 중",
    copy: "메시지 복사",
    copied: "복사됨",
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

type Turn = { id: string; role: "user" | "assistant"; text: string; streaming: boolean; thinking: boolean };

function StreamingMarkdown({ value, streaming }: { value: string; streaming: boolean }) {
  const rehypePlugins = useStreamingReveal(value, streaming);
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
      { id: `user-${stamp}`, role: "user", text: copy.question, streaming: false, thinking: false },
    ]);
    const schedule = (delay: number, run: () => void) => { timers.current.push(window.setTimeout(run, delay)); };
    schedule(160, () => setTurns((current) => [
      ...current,
      { id: assistantId, role: "assistant", text: "", streaming: true, thinking: true },
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
          <MessageRow key={turn.id} role="user" entering={entering.has(turn.id)}>
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
              <MessageFooter>
                <CopyButton text={turn.text} label={copy.copy} copiedLabel={copy.copied} />
              </MessageFooter>
            ) : null}
          </MessageRow>
        ))}
      </div>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Default", render: () => <MessageRowFixture /> },
  {
    name: "Send and stream",
    states: ["enter", "streaming", "thinking"],
    widths: ["375", "app", "wide"],
    render: (context) => <SendAndStream context={context} />,
  },
  {
    name: "Thinking",
    states: ["thinking"],
    render: (context) => (
      <MessageStatusRow>
        <MessageStatusLabel mark={<Spinner size={14} />} shimmer>
          <Typo.Body as="span">{text(context).thinking}</Typo.Body>
        </MessageStatusLabel>
      </MessageStatusRow>
    ),
  },
];
