import { Card } from "../../../Card";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import { type SpacingCopy } from "./spacingCopy";
import { count } from "./spacingCount";
import { Units } from "./Units";
import s from "./SpacingHero.module.css";

/** A card, its inset highlighted, the top inset's units beside it. */
export function InsetCard({ copy }: { copy: SpacingCopy }) {
  return (
    <span className={s.insetCard}>
      <Card padding="md">
        <Stack gap="xs">
          <Typo.Label as="span">{copy.cardTitle}</Typo.Label>
          <Typo.Body tone="secondary">{copy.cardBody}</Typo.Body>
        </Stack>
      </Card>
      <span className={s.inset} />
      <span className={s.insetUnits}><Units n={count(12)} /></span>
    </span>
  );
}
