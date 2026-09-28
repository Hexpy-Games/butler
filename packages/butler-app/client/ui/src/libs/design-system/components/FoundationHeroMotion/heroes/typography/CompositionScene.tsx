import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { FoundationHeroLang } from "../../FoundationHeroMotion";
import t from "./TypographyHero.module.css";

const COPY: Record<FoundationHeroLang, { title: string; body: string; prefix: string; suffix: string }> = {
  en: { title: "Weekly summary", body: "Butler read the repo, planned the change, then asked first.", prefix: "", suffix: " tokens · 2 files" },
  ko: { title: "주간 요약", body: "저장소를 읽고 계획을 세운 뒤, 쓰기 전에 먼저 물었습니다.", prefix: "토큰 ", suffix: "개 · 파일 2개" },
};
/** 12,480 → 12,512: the last three digits roll; the line around them never moves. */
const ROLL = [[4, 5], [8, 1], [0, 2]] as const;
const LINES = ["title", "body", "caption"] as const;

interface Geometry {
  /** Transform that sets each resolved line back into the uniform paragraph. */
  flips: Record<(typeof LINES)[number], string>;
  tops: Record<(typeof LINES)[number], number>;
  bodyTop: number;
  bodyRows: number;
  leading: number;
  label: string;
}

function measure(card: HTMLElement): Geometry | null {
  const lines = LINES.map((line) => card.querySelector<HTMLElement>(`[data-line="${line}"]`));
  if (lines.some((line) => !line)) return null;
  const body = getComputedStyle(lines[1]!);
  const size = Number.parseFloat(body.fontSize);
  const leading = Number.parseFloat(body.lineHeight);
  if (!Number.isFinite(size) || !Number.isFinite(leading)) return null;
  let uniformTop = lines[0]!.offsetTop;
  const flips = {} as Geometry["flips"];
  const tops = {} as Geometry["tops"];
  let bodyRows = 1;
  LINES.forEach((name, index) => {
    const line = lines[index]!;
    const style = getComputedStyle(line);
    const rows = Math.max(1, Math.round(line.offsetHeight / Number.parseFloat(style.lineHeight)));
    if (name === "body") bodyRows = rows;
    flips[name] = `translateY(${Math.round(uniformTop - line.offsetTop)}px) scale(${Math.round((size / Number.parseFloat(style.fontSize)) * 1000) / 1000})`;
    tops[name] = line.offsetTop;
    uniformTop += rows * leading;
  });
  return { flips, tops, bodyTop: lines[1]!.offsetTop, bodyRows, leading, label: `${Math.round(size)}/${Math.round(leading)}` };
}

function Roller() {
  return (
    <>
      {ROLL.map(([from, to], index) => (
        <span className={t.digit} key={index} style={{ "--from": from, "--to": to, "--at": index * 0.004 } as CSSProperties}>
          <span className={t.digitStrip}>{Array.from({ length: 10 }, (_, digit) => <span key={digit}>{digit}</span>)}</span>
        </span>
      ))}
    </>
  );
}

/**
 * Scene 3, composition: a paragraph set uniformly in the body role resolves
 * into hierarchy (title, body, caption) with FLIP transforms measured from the
 * live layout; the role of each line is annotated, the body leading is shown
 * by guides that recede again, and tabular digits roll without moving the
 * caption around them.
 */
export function CompositionScene({ lang }: { lang: FoundationHeroLang }) {
  const ref = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  useEffect(() => {
    if (ref.current && typeof getComputedStyle === "function") setGeometry(measure(ref.current));
  }, [lang]);
  const copy = COPY[lang];
  const caption = <>{copy.prefix}12,<Roller />{copy.suffix}</>;
  const flip = (line: (typeof LINES)[number]) => ({ "--uniform": geometry?.flips[line] ?? "none" }) as CSSProperties;
  const at = (top: number | undefined) => ({ "--y": `${top ?? 0}px` }) as CSSProperties;
  return (
    <div className={t.scene} data-scene="composition">
      <div className={t.card} lang={lang} ref={ref}>
        <div className={t.line} data-line="title" style={flip("title")}>
          <span className={t.titleStrong}>{copy.title}</span>
          <span className={t.titlePlain} aria-hidden="true">{copy.title}</span>
        </div>
        <div className={t.line} data-line="body" style={flip("body")}>{copy.body}</div>
        <div className={t.line} data-line="caption" style={flip("caption")}>
          <span className={t.captionQuiet}>{caption}</span>
          <span className={t.captionPlain} aria-hidden="true">{caption}</span>
        </div>
        {geometry ? Array.from({ length: geometry.bodyRows + 1 }, (_, row) => (
          <span className={t.guide} key={row} style={{ "--y": `${geometry.bodyTop + row * geometry.leading}px`, "--at": row * 0.004 } as CSSProperties} />
        )) : null}
        <span className={t.notes} data-note="roles">
          {LINES.map((line) => <span className={t.note} key={line} style={at(geometry?.tops[line])}>{line === "title" ? "h3" : line}</span>)}
        </span>
        <span className={t.notes} data-note="leading">
          <span className={t.note} style={at(geometry ? geometry.bodyTop + (geometry.bodyRows * geometry.leading) / 2 - geometry.leading / 2 : 0)}>{geometry?.label ?? "14/20"}</span>
        </span>
        <span className={t.notes} data-note="numerals">
          <span className={t.note} style={at(geometry?.tops.caption)}>tnum</span>
        </span>
      </div>
    </div>
  );
}
