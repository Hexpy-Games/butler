import { SurfacePanel } from "../../../../blocks/SurfacePanel";
import { Box } from "../../../Box";
import { Typo } from "../../../Typo";
import { LEVELS, type RadiusCopy } from "./radiusCopy";
import s from "./RadiusHero.module.css";

/** Finale: the three shadows front-on, each on the surface that casts it: a control's panel, a dragged card, a window. */
export function LiftTile({ copy }: { copy: RadiusCopy }) {
  const name = (k: number) => (
    <span className={s.liftName}>
      <Typo.Label as="span">{copy[LEVELS[k]!.when]}</Typo.Label>
      <span className={s.liftToken}>{LEVELS[k]!.token}</span>
    </span>
  );
  return (
    <div className={s.liftTile}>
      <SurfacePanel elevation="low">{name(0)}</SurfacePanel>
      <span className={s.dragCard} data-lifted="">
        <span className={s.dragShadow} />
        <Box border="hairline" padding="md" radius="panel" surface="raised">{name(1)}</Box>
      </span>
      <SurfacePanel elevation="high">{name(2)}</SurfacePanel>
    </div>
  );
}
