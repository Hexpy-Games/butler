import s from "./SpacingHero.module.css";

/** Units of a column, bottom first (named `${name}-u${j}` for the timeline). */
export function Units({ n, name, row = false }: { n: number; name?: string; row?: boolean }) {
  return (
    <span className={s.units} data-row={row ? "" : undefined}>
      {Array.from({ length: n }, (_, j) => <span className={s.u} data-t={name ? `${name}-u${j}` : undefined} key={j} />)}
    </span>
  );
}
