import s from "./SpacingHero.module.css";

/** The title's touch: its letters drift apart and 4px blocks sit in the gaps. */
export function TitleLetters({ title }: { title: string }) {
  const letters = [...title];
  return (
    <span className={s.letters}>
      {letters.map((ch, k) => (
        <span className={s.letter} data-t={`tl-${k}`} key={k}>
          {ch}
          {k < letters.length - 1 ? <span className={s.letterBlock} data-t={`tb-${k}`} /> : null}
        </span>
      ))}
    </span>
  );
}
