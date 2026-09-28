import type { ReactNode } from "react";
import { Notice } from "../../../../blocks/Notice";
import { motionDuration, type MotionDurationName, type MotionEasingName } from "../../../../lib/motion";
import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { ButtonContainer } from "../../../ButtonContainer";
import { Archive, CheckCircle2, Copy, PencilLine } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { Topic } from "../shared/Topic";
import type { BuildSpec } from "../shared/types";
import type { MotionCopy } from "./motionCopy";
import { Plot } from "./MotionScenes";
import s from "./MotionHero.module.css";

/** What each build's component plays: the duration token it enters on, its curve, and where it starts from. */
export const PLAYS: Record<string, { token: MotionDurationName; ease: MotionEasingName; from: { o?: number; s?: number; y?: number } }> = {
  menu: { token: "menu", ease: "standard", from: { o: 0, s: 0.97 } },
  dialog: { token: "base", ease: "standard", from: { o: 0, s: 0.96 } },
  toast: { token: "base", ease: "standard", from: { o: 0, y: -24 } },
  press: { token: "fast", ease: "standard", from: { s: 0.97 } },
};

/** The duration token as the component names it, for the badge. */
const TOKEN: Record<string, string> = { menu: "--motion-enter-menu", dialog: "--motion-enter-overlay", toast: "--motion-enter-overlay", press: "--motion-scale-press" };

function stage(id: string, component: ReactNode) {
  return (
    <div className={s.stageRow}>
      <Mark n={id} part sketch><span className={s.mover} data-t={`mv-${id}`}>{component}</span></Mark>
      <Mark n={`bp-${id}`} part><Plot ease={PLAYS[id]!.ease} id={`bp-${id}`} size={48} /></Mark>
    </div>
  );
}

function steps(id: string, text: string[]): BuildSpec["steps"] {
  const play = PLAYS[id]!;
  const ms = motionDuration(play.token);
  const label = id === "press" ? [TOKEN[id]!, `${TOKEN[id]} · --motion-fast ${ms}ms`] : [TOKEN[id]!, `${TOKEN[id]} · ${ms}ms · ${play.ease}`];
  return [
    { text: [`${id}-topic`] },
    { parts: [id], text },
    { parts: [`bp-${id}`], annots: [{ kind: "tag", target: id, label }] },
    // Room for the component to play its motion twice, the dot running the plotted curve beside it.
    { secondary: true, after: 3.2 },
  ];
}

/**
 * Components by topic (menu, dialog, toast, press): each is built, then
 * plays its own motion (slowed three times) twice while a dot runs its
 * easing curve beside it, under a badge naming the duration and curve.
 */
export function motionBuilds(copy: MotionCopy): BuildSpec[] {
  const { topics } = copy;
  const items: Array<[string, ReactNode]> = [[copy.rename, <PencilLine key="a" size="md" />], [copy.duplicate, <Copy key="b" size="md" />], [copy.archive, <Archive key="c" size="md" />]];
  return [
    {
      id: "menu",
      render: <Topic id="menu" title={topics.menu}>{stage("menu", (
        <Box border="hairline" padding="xs" radius="popover" surface="overlay">
          {items.map(([label, glyph], k) => <div className={s.menuRow} key={label}>{glyph}<Typo.Body><R name={`mn-${k}`}>{label}</R></Typo.Body></div>)}
        </Box>
      ))}</Topic>,
      steps: steps("menu", ["mn-0", "mn-1", "mn-2"]),
    },
    {
      id: "dialog",
      render: <Topic id="dialog" title={topics.dialog}>{stage("dialog", (
        <Box border="hairline" padding="lg" radius="popover" surface="overlay">
          <Stack gap="md">
            <Stack gap="xs">
              <Typo.H5 as="span"><R name="dg-t">{copy.dialogTitle}</R></Typo.H5>
              <Typo.Body tone="secondary"><R name="dg-b">{copy.dialogBody}</R></Typo.Body>
            </Stack>
            <ButtonContainer justify="end" size="default">
              <Button text={<R name="dg-c">{copy.cancel}</R>} variant="outline" />
              <Button text={<R name="dg-o">{copy.confirm}</R>} />
            </ButtonContainer>
          </Stack>
        </Box>
      ))}</Topic>,
      steps: steps("dialog", ["dg-t", "dg-b", "dg-c", "dg-o"]),
    },
    {
      id: "toast",
      render: <Topic id="toast" title={topics.toast}>{stage("toast", <Notice tone="success" icon={<CheckCircle2 size="md" />} message={<R name="ts-t">{copy.toastTitle}</R>} />)}</Topic>,
      steps: steps("toast", ["ts-t"]),
    },
    {
      id: "press",
      render: <Topic id="press" title={topics.press}>{stage("press", <Button text={<R name="pr-t">{copy.send}</R>} />)}</Topic>,
      steps: steps("press", ["pr-t"]),
    },
  ];
}
