import { Button } from "../../../Button";
import { ButtonContainer } from "../../../ButtonContainer";
import { type SpacingCopy } from "./spacingCopy";
import { count } from "./spacingCount";
import { Units } from "./Units";
import s from "./SpacingHero.module.css";

/** Two buttons; the gap between them highlighted, its two units under it. */
export function Inline({ copy }: { copy: SpacingCopy }) {
  return (
    <ButtonContainer size="default">
      <Button text={copy.cancel} variant="outline" />
      <span className={s.after}>
        <span className={s.inlineGap}>
          <span className={s.fill} />
          <Units n={count(8)} row />
        </span>
        <Button text={copy.save} />
      </span>
    </ButtonContainer>
  );
}
