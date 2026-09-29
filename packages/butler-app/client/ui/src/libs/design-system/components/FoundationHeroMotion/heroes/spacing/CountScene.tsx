import { type SpacingCopy } from "./spacingCopy";
import { Section } from "./Section";
import s from "./SpacingHero.module.css";

/** Scene 3 (signature): a real settings section; each space in turn is highlighted, counted in units beside it and named. */
export function CountScene({ copy }: { copy: SpacingCopy }) {
  return (
    <div className={s.countStage} data-m="ex">
      <Section copy={copy} labels="full" name="ex" />
    </div>
  );
}
