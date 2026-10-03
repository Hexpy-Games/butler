import type { CSSProperties } from "react";
import type { DecorationTheme } from "./types";
import styles from "./decorations.module.css";

function Flower({ index }: { index: number }) {
  return <svg viewBox="0 0 24 32" fill="none" focusable="false">
    <path d="M12 31 Q15 22 11 12 M13 25 Q3 26 5 20 Q11 19 13 25 M13 22 Q21 23 21 17 Q15 17 13 22"
      stroke="var(--decor-stem)" fill="var(--decor-leaf)" strokeWidth="1.2" strokeLinecap="round" />
    <g fill={index % 3 === 0 ? "var(--decor-petal)" : "var(--decor-cream)"}>
      {[0, 60, 120, 180, 240, 300].map(angle => <ellipse key={angle} cx="12" cy="5" rx="2.8" ry="4.4" transform={`rotate(${angle} 12 10)`} />)}
    </g>
    <circle cx="12" cy="10" r="2.8" fill="var(--decor-gold)" />
  </svg>;
}

function Blossom({ small = false }: { small?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="var(--decor-petal)" focusable="false">
    {small ? <path d="M6 4 Q19 2 18 12 Q12 21 6 4Z" /> : <>
      {[0, 72, 144, 216, 288].map(angle => <path key={angle} d="M12 12 C2 9 4 1 9 3 L12 5 L15 3 C21 7 18 11 12 12"
        transform={`rotate(${angle} 12 12)`} />)}
      <circle cx="12" cy="12" r="2" fill="var(--decor-gold)" />
    </>}
  </svg>;
}

function Character({ index }: { index: number }) {
  const rabbit = index % 2 === 0;
  return <svg viewBox="0 0 40 40" fill="none" focusable="false">
    <ellipse cx="20" cy="38" rx="12" ry="1.5" fill="var(--decor-shadow)" />
    <path d="M13 24 Q6 25 6 30 M27 24 Q33 20 33 16" stroke="var(--decor-ink)" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M12 34 Q8 40 5 36 M26 34 Q30 40 33 35" stroke="var(--decor-ink)" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M12 21 Q7 36 19 36 Q32 35 27 21Z" fill={rabbit ? "var(--decor-petal)" : "var(--decor-leaf)"} />
    {rabbit ? <path d="M12 13 Q4 -4 11 2 Q15 5 16 12 M22 12 Q24 -4 29 2 Q32 6 27 15" fill="var(--decor-cream)" stroke="var(--decor-outline)" />
      : <path d="M9 13 L9 4 L17 9 M23 9 L31 4 L31 15" fill="var(--decor-gold)" stroke="var(--decor-outline)" />}
    <path d="M8 16 Q8 7 20 8 Q33 7 32 19 Q31 27 20 26 Q8 27 8 16Z"
      fill={rabbit ? "var(--decor-cream)" : "var(--decor-gold)"} stroke="var(--decor-outline)" />
    <path d="M15 17v1 M25 17v1 M18 21q2 2 4 0" stroke="var(--decor-ink)" strokeWidth="1.4" strokeLinecap="round" />
    <ellipse cx="12" cy="21" rx="2.5" ry="1.2" fill="var(--decor-petal)" />
    <ellipse cx="28" cy="21" rx="2.5" ry="1.2" fill="var(--decor-petal)" />
  </svg>;
}

function CherryTree() {
  return <svg className={styles.tree} viewBox="0 0 320 40" preserveAspectRatio="xMinYMax meet" fill="none" focusable="false">
    <path d="M4 39 Q18 21 59 22 T134 8 M37 24 Q40 12 78 7 M66 20 Q94 29 125 20 M94 15 Q110 0 139 4"
      stroke="var(--decor-stem)" strokeWidth="2" strokeLinecap="round" />
    {[ [36,14], [54,21], [74,7], [89,22], [109,10], [128,20], [137,5] ].map(([x,y], i) =>
      <g key={i} transform={`translate(${x} ${y})`} fill={i % 2 ? "var(--decor-cream)" : "var(--decor-petal)"}>
        <circle cx="-3" r="4" /><circle cy="-3" r="4" /><circle cx="3" r="4" /><circle cy="3" r="4" />
        <circle r="1.5" fill="var(--decor-gold)" />
      </g>)}
  </svg>;
}

/** Reviewed vector art only. All 24 sprites are preallocated; no emitter or asset fetch. */
export function DecorationArt({ theme }: { theme: DecorationTheme }) {
  const count = theme === "characters" ? 5 : 24;
  return <>
    {theme === "cherry" ? <CherryTree /> : null}
    {Array.from({ length: count }, (_, index) => <div className={styles.anchor} key={index}
      style={{ "--x": `${4 + index * 92 / (count - 1)}%`, "--size": `${theme === "characters" ? 38 : 20 + index % 4 * 2}px`,
        "--lift": `${theme === "cherry" ? index % 4 * 4 : 0}px` } as CSSProperties}>
      <div className={styles.sprite} data-decor-sprite data-reaction={theme}>
        {theme === "flowers" ? <Flower index={index} /> : theme === "cherry" ? <Blossom small={index % 3 !== 0} /> : <Character index={index} />}
      </div>
    </div>)}
  </>;
}
