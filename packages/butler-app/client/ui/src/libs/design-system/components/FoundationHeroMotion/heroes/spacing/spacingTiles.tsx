import { type SpacingCopy } from "./spacingCopy";
import { Inline } from "./Inline";
import { InsetCard } from "./InsetCard";
import { Section } from "./Section";
import { sum } from "./spacingCount";
import { Staircase } from "./Staircase";
import s from "./SpacingHero.module.css";

/** Finale tiles. */
export const StairsTile = () => <div className={s.stairsTile}><Staircase /></div>;

export const SectionTile = ({ copy }: { copy: SpacingCopy }) => <div className={s.sectionTile}><Section copy={copy} /></div>;

export const InlineTile = ({ copy }: { copy: SpacingCopy }) => (
  <div className={s.inlineTile}>
    <Inline copy={copy} />
    <span className={s.caption}>{`--space-sm · ${sum(8)}`}</span>
  </div>
);

export const CardTile = ({ copy }: { copy: SpacingCopy }) => (
  <div className={s.inlineTile}>
    <InsetCard copy={copy} />
    <span className={s.caption}>{`--space-md · ${sum(12)}`}</span>
  </div>
);
