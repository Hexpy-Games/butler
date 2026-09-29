import { type RadiusCopy } from "./radiusCopy";
import { Level } from "./Level";
import { cardBody } from "./RadiusScenes";
import s from "./RadiusHero.module.css";

/** Scene 6: a card you drag: it lifts (scale and --shadow-drag-lift, as SortableCardList does), moves down a slot and settles. */
export function DragScene({ copy }: { copy: RadiusCopy }) {
  return (
    <Level copy={copy} k={1}>
      <span className={s.cards}>
        {copy.cards.map(([title, body], k) => (
          <span className={s.dragCard} data-lifted={k === 0 ? "" : undefined} data-m={`dc-${k}`} data-t={`dc-${k}`} key={title}>
            {k === 0 ? <span className={s.dragShadow} data-t="dshadow" /> : null}
            {cardBody(title, body)}
          </span>
        ))}
      </span>
    </Level>
  );
}
