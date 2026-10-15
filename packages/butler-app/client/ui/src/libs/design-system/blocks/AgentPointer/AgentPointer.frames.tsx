import { useLayoutEffect, useRef, useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Grid } from "../../components/Grid";
import { motionDuration } from "../../lib/motion";
import { shopCardRect } from "../BrowserPane/fixtures/pages";
import { AgentPointer, type AgentPointerProps } from "./AgentPointer";
import { PageStage, POINTER_LABELS, type StageScale } from "./AgentPointer.demo";

type Locale = ShowcaseRenderContext["locale"];
type Scene = Pick<AgentPointerProps, "mode" | "at" | "target" | "from" | "steps">;

/** A motion in phases: the pointer starts in `scenes[0]`; each later scene is applied `at` ms into the motion. */
interface Motion { scenes: ((scale: StageScale) => Scene)[]; at: number[]; times: number[] }

const card = (s: StageScale, index: number): Scene => ({ mode: "click", at: s.cardPoint(index), target: s.rect(shopCardRect(index)) });
const hop = (s: StageScale, from: number, to: number): Scene => ({ ...card(s, to), from: s.cardPoint(from) });

export const MOTIONS = {
  ringAppear: { scenes: [(s) => ({ mode: "observe", at: s.cardPoint(1) }), (s) => card(s, 1)], at: [0], times: [0, 30, 60, 90, 120, 240] },
  targetChange: { scenes: [(s) => card(s, 1), (s) => hop(s, 1, 2)], at: [0], times: [0, 45, 90, 160, 280, 400] },
  wholePage: {
    scenes: [(s) => card(s, 1), (s) => ({ mode: "observe", at: s.cardPoint(1), target: { x: 0, y: 0, width: s.width, height: s.height } })],
    at: [0], times: [0, 30, 60, 90, 120, 240],
  },
  curvedGlide: { scenes: [(s) => card(s, 4), (s) => hop(s, 4, 3)], at: [0], times: [0, 80, 160, 240, 320, 400] },
  interrupted: { scenes: [(s) => card(s, 4), (s) => hop(s, 4, 3), (s) => hop(s, 3, 0)], at: [0, 160], times: [0, 80, 160, 240, 400, 560] },
  batch: {
    scenes: [
      (s) => ({ mode: "batch", at: s.cardPoint(1), steps: [s.cardPoint(4), s.cardPoint(1)], target: s.rect(shopCardRect(1)) }),
      (s) => ({ mode: "batch", at: s.cardPoint(6), steps: [s.cardPoint(4), s.cardPoint(1), s.cardPoint(6)], target: s.rect(shopCardRect(6)) }),
    ],
    at: [0], times: [0, 80, 160, 240, 320, 400],
  },
} satisfies Record<string, Motion>;

/** Holds every animation the last change started under `node` at `ms` into its own timeline. */
function holdAt(node: HTMLElement, ms: number) {
  for (const animation of node.getAnimations({ subtree: true })) {
    // Held by an earlier phase: keep its frame.
    if (animation.playState === "paused") continue;
    // Over by then: let it finish, so what follows it (the ripple on arrival) happens.
    if (Number(animation.effect?.getComputedTiming().endTime) <= ms) { animation.finish(); continue; }
    animation.pause();
    animation.currentTime = Math.max(0, ms);
  }
}

/** One frozen frame: plays the scenes in order, holding the motion `time` ms after the first change. */
function Frame({ motion, time, scale, locale, reducedMotion }: { motion: Motion; time: number; scale: StageScale; locale: Locale; reducedMotion?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState(0);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    if (phase === 0) {
      // The starting scene is at rest: its entrance fades are over before the motion begins.
      for (const animation of node.getAnimations({ subtree: true })) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)) animation.finish();
      }
      setPhase(1);
      return;
    }
    const started = motion.at[phase - 1]!;
    const next = motion.at[phase];
    holdAt(node, Math.min(time, next ?? Infinity) - started);
    if (next !== undefined && time > next) { setPhase(phase + 1); return; }
    if (next !== undefined) return;
    // Last phase: what starts on arrival (the ripple) is held at the time since the glide ended.
    const observer = new MutationObserver(() => holdAt(node, time - started - motionDuration("pointer-glide")));
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [phase, motion, time]);
  const scene = motion.scenes[Math.min(phase, motion.scenes.length - 1)]!(scale);
  return (
    <div ref={host} style={{ position: "absolute", inset: 0 }}>
      <AgentPointer {...scene} width={scale.width} height={scale.height} labels={POINTER_LABELS[locale]} reducedMotion={reducedMotion} />
    </div>
  );
}

/** A strip of frozen frames of one motion, labelled with their time. */
export function FrameStrip({ locale, motion, reducedMotion }: { locale: Locale; motion: Motion; reducedMotion?: boolean }) {
  return (
    <Grid columns={{ base: "2", wide: "3" }} gap="sm">
      {motion.times.map((time) => (
        <PageStage key={time} locale={locale} caption={`${time} ms`} data-pointer-frame={String(time)}>
          {(scale) => <Frame motion={motion} time={time} scale={scale} locale={locale} reducedMotion={reducedMotion} />}
        </PageStage>
      ))}
    </Grid>
  );
}
