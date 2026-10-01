import s from "./IconHero.module.css";

/**
 * The title's touch: the first "o" is the Butler mark (its ring and the two
 * chevrons of its collar) on its keyline square, stroked on. Drawn at the
 * "o" glyph's own x-height, weight and centre (see .titleO).
 */
export function TitleWord({ title }: { title: string }) {
  const at = title.indexOf("o");
  if (at < 0) return <span>{title}</span>;
  return (
    <span className={s.titleWord}>
      {title.slice(0, at)}
      <span className={s.titleO}>
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <rect className={s.titleKey} data-t="to-k" height="100" width="100" x="0" y="0" />
          <path className={s.titleRing} d="M50 12a38 38 0 1 1 0 76a38 38 0 1 1 0-76" data-t="to-c" pathLength={100} />
          <path className={s.titleCollar} d="M30.4 41.1L50 50L69.6 41.1" data-t="to-m1" pathLength={100} />
          <path className={s.titleCollar} d="M30.4 58.9L50 50L69.6 58.9" data-t="to-m2" pathLength={100} />
        </svg>
      </span>
      {title.slice(at + 1)}
    </span>
  );
}
