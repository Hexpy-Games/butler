import { Reveal as R } from "../shared/Reveal";
import { COMPACT_PAD, GAPS, type SpacingCopy } from "./spacingCopy";
import { Section } from "./Section";
import s from "./SpacingHero.module.css";

/** Scene 5: comfortable beside compact; only the card inset changes, 6 units to 4. */
export function DensityScene({ copy }: { copy: SpacingCopy }) {
  const head = (name: string, px: number, id: string) => (
    <span className={s.densityHead}>
      <span><R name={`${id}-h`}>{name}</R></span>
      <span className={s.readToken}><R name={`${id}-k`}>{`${GAPS.pt.token} ${px}`}</R></span>
    </span>
  );
  return (
    <div className={s.densityStage} data-m="dn">
      <div className={s.densityCol}>{head(copy.comfortable, GAPS.pt.px, "dc")}<Section copy={copy} labels="short" name="dc" only={["pt", "pb"]} /></div>
      <div className={s.densityCol}>{head(copy.compact, COMPACT_PAD, "dk")}<Section copy={copy} density="compact" labels="short" name="dk" only={["pt", "pb"]} /></div>
    </div>
  );
}
