import s from "./LayersHero.module.css";

/** The title's touch: three offset copies of the word, merging into one. */
export function TitleCopies({ title }: { title: string }) {
  return (
    <span className={s.titleStack}>
      <span className={s.titleCopy} data-k="2" data-t="tc-2">
        {title}
      </span>
      <span className={s.titleCopy} data-k="1" data-t="tc-1">
        {title}
      </span>
      <span>{title}</span>
    </span>
  );
}
