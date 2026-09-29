import s from "./SizingHero.module.css";

/**
 * The title's touch: four rails on the word's own lines (cap height,
 * x-height, baseline, descender), drawn left to right like a staff.
 */
export const TitleRails = (
  <svg className={s.titleRails} preserveAspectRatio="none" viewBox="0 0 100 100">
    {[10.5, 28, 74, 87].map((y, k) => <line data-t={`tr-${k}`} key={y} pathLength={100} x1="0" x2="100" y1={y} y2={y} />)}
  </svg>
);
