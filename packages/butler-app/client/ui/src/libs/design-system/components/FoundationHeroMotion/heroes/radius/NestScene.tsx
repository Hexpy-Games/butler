import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { type RadiusCopy } from "./radiusCopy";
import s from "./RadiusHero.module.css";

/** Scene 4: the only nested pair, their arcs concentric; a wrong inner corner flashes and morphs back. */
export function NestScene({ copy }: { copy: RadiusCopy }) {
  return (
    <div className={s.nestStage}>
      <div className={s.nestCard} data-m="nest">
        <Box border="hairline" padding="lg" radius="panel" surface="raised">
          <span className={s.nestButton}>
            <Button text={copy.button} />
            <span className={s.wrong} data-t="nw" />
            <span className={s.arc} data-size="inner" data-t="na-i" />
            <span className={s.nestNote} data-place="inner" data-t="nn-i">--radius-control 8</span>
          </span>
        </Box>
        <span className={s.arc} data-size="outer" data-t="na-o" />
        <span className={s.padMark} data-t="np" />
        <span className={s.nestNote} data-place="outer" data-t="nn-o">--radius-panel 10</span>
      </div>
    </div>
  );
}
