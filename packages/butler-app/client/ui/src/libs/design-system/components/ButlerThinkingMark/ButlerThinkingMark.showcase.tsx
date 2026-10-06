import { useEffect, useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import type { IconSize } from "../Icons";
import { LoadingIndicator } from "../LoadingIndicator";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { ButlerThinkingMark, type ButlerThinkingMarkState } from "./ButlerThinkingMark";

export const meta: ShowcaseMeta = {
  title: "ButlerThinkingMark",
  category: "Feedback",
  tags: ["brand", "identity", "logo", "thinking", "working", "activity", "motion", "halftone", "canvas"],
  status: "beta",
};

const SIZES: IconSize[] = ["sm", "md", "lg", "xl", "2xl", "3xl"];
/** Round trip demo: hold the thinking form (the morph lands in ~2s) before settling back. */
const ROUND_TRIP_HOLD_MS = 3200;

const labels = {
  "en-US": {
    start: "Start working", finish: "Finish", replay: "Replay", roundTrip: "Replay idle → thinking → idle", idle: "Idle (the logo)", working: "Working",
    reduced: "Reduced motion: the logo breathes in opacity", fill: "Fill (no size)",
    thinking: "Thinking", worked: "Worked for 12s", task: "Build the token pages", running: "Running", complete: "Complete",
  },
  "ko-KR": {
    start: "작업 시작", finish: "완료", replay: "다시 재생", roundTrip: "대기 → 생각 → 대기 다시 재생", idle: "대기 (로고)", working: "작업 중",
    reduced: "모션 줄이기: 로고가 불투명도로 숨 쉼", fill: "채우기 (size 없음)",
    thinking: "생각 중", worked: "12초 동안 작업함", task: "토큰 페이지 빌드", running: "진행 중", complete: "완료",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function Row({ state, reducedMotion }: { state: ButlerThinkingMarkState; reducedMotion?: boolean }) {
  return (
    <Stack align="row" gap="lg" cross="end" wrap>
      {SIZES.map((size) => (
        <Stack gap="xs" cross="center" key={size}>
          <ButlerThinkingMark state={state} size={size} reducedMotion={reducedMotion} />
          <Typo.Caption tone="tertiary">{size}</Typo.Caption>
        </Stack>
      ))}
    </Stack>
  );
}

/** One continuous morph each way: the clean logo straight into the halftone moon, and back. */
function IdleToWorking({ context }: { context: ShowcaseRenderContext }) {
  const [state, setState] = useState<ButlerThinkingMarkState>("idle");
  const [run, setRun] = useState(0);
  const [roundTrip, setRoundTrip] = useState(0);
  const copy = text(context);
  useEffect(() => {
    if (roundTrip === 0) return undefined;
    setState("working");
    const settle = window.setTimeout(() => setState("idle"), ROUND_TRIP_HOLD_MS);
    return () => window.clearTimeout(settle);
  }, [roundTrip]);
  return (
    <Stack gap="md" data-ds-thinking-mark-demo={state}>
      <Stack key={run}><Row state={state} /></Stack>
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" data-ds-motion="thinking-mark" text={state === "idle" ? copy.start : copy.finish}
          onClick={() => setState(state === "idle" ? "working" : "idle")} />
        <Button size="sm" variant="borderless" data-ds-motion="thinking-mark-round-trip" text={copy.roundTrip}
          onClick={() => setRoundTrip(roundTrip + 1)} />
        <Button size="sm" variant="borderless" data-ds-motion="thinking-mark-replay" text={copy.replay}
          onClick={() => { setState("working"); setRun(run + 1); }} />
      </ButtonContainer>
    </Stack>
  );
}

/** Assistant status: the mark stays mounted; done settles it back to the logo (no check). */
function StatusToDone({ context }: { context: ShowcaseRenderContext }) {
  const [working, setWorking] = useState(true);
  const copy = text(context);
  return (
    <Stack gap="md">
      <Stack align="row" gap="sm" cross="center">
        <ButlerThinkingMark state={working ? "working" : "idle"} size="lg" />
        <Typo.Body>{working ? copy.thinking : copy.worked}</Typo.Body>
      </Stack>
      <Stack align="row" gap="sm" cross="center">
        <LoadingIndicator state={working ? "loading" : "done"} size={20} />
        <Typo.Body>{`${copy.task} · ${working ? copy.running : copy.complete}`}</Typo.Body>
      </Stack>
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" data-ds-motion="thinking-mark-done" text={working ? copy.finish : copy.start}
          onClick={() => setWorking(!working)} />
      </ButtonContainer>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Idle to working", states: ["idle", "working"], render: (context) => <IdleToWorking context={context} /> },
  {
    name: "Sizes",
    render: (context) => (
      <Stack gap="lg">
        <Typo.Caption>{text(context).idle}</Typo.Caption>
        <Row state="idle" />
        <Typo.Caption>{text(context).working}</Typo.Caption>
        <Row state="working" />
        <Typo.Caption>{text(context).fill}</Typo.Caption>
        <Stack UNSAFE_style={{ width: 96 }}><ButlerThinkingMark state="working" /></Stack>
      </Stack>
    ),
  },
  {
    name: "Reduced motion",
    render: (context) => (
      <Stack gap="sm">
        <Typo.Caption>{text(context).reduced}</Typo.Caption>
        <Row state="working" reducedMotion />
      </Stack>
    ),
  },
  { name: "Status to done", states: ["working", "done"], render: (context) => <StatusToDone context={context} /> },
];
