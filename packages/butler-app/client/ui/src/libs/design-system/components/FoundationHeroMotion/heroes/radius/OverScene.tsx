import { SurfacePanel } from "../../../../blocks/SurfacePanel";
import { Button } from "../../../Button";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import { type RadiusCopy } from "./radiusCopy";
import { Level } from "./Level";
import { cardBody } from "./RadiusScenes";
import s from "./RadiusHero.module.css";

/** Scene 7: a window over content: a panel at elevation high opens over the page's cards on --shadow-window. */
export function OverScene({ copy }: { copy: RadiusCopy }) {
  return (
    <Level copy={copy} k={2}>
      <span className={s.cards}>
        {copy.cards.map(([title, body]) => <span key={title}>{cardBody(title, body)}</span>)}
        <span className={s.window} data-t="win">
          <SurfacePanel elevation="high">
            <Stack gap="md">
              <Stack gap="xs"><Typo.Label as="span">{copy.shareTitle}</Typo.Label><Typo.Caption>{copy.shareBody}</Typo.Caption></Stack>
              <Stack align="row" gap="sm" justify="end"><Button size="sm" text={copy.cancel} variant="outline" /><Button size="sm" text={copy.share} /></Stack>
            </Stack>
          </SurfacePanel>
        </span>
      </span>
    </Level>
  );
}
