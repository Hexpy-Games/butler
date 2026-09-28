import type { CSSProperties } from "react";
import { Tag } from "../../../Tag";
import type { TypeCopy } from "./typeCopy";
import type { LineInfo } from "./typeLines";
import t from "./TypographyHero.module.css";

/** Dash length that covers a line's outlines: generous per character, more for Hangul. */
export function lineDash(line: LineInfo): number {
  return [...line.text].reduce((sum, char) => sum + (/[ㄱ-힝]/u.test(char) ? 7 : 4), 0) * line.font.size;
}

/** The tag's steps: the token, then its size, its line height, its tracking as each is applied. */
export function tagSteps(line: LineInfo, copy: TypeCopy, compact: boolean): string[] {
  const token = compact ? line.token : `${copy.roles[line.role]} · ${line.token}`;
  const size = `${Math.round(line.font.size)}px`;
  const leading = `${size}/${Math.round(line.font.lineHeight)}`;
  return [token, `${line.token} · ${size}`, `${line.token} · ${leading}`, `${line.token} · ${leading} · ${line.font.tracking}`];
}

/**
 * The build layer of one component, a pure overlay (absolute, no layout): for
 * each text line, a token tag far out in the frame gutter joined to the line
 * by a thin leader; the line's own outline (same font, size and weight as the
 * real text) drawn along its contours at a neutral size, then set to its role
 * size; its line box shown as a leading band with a baseline-to-baseline
 * measure; the tag counting the values in as they apply; then the real text
 * fills in and the guides recede.
 */
export function LineOverlay({ lines, copy, compact }: { lines: LineInfo[]; copy: TypeCopy; /** Token name only (tall canvas). */ compact: boolean }) {
  return (
    <span className={t.lines} aria-hidden="true">
      {lines.map((line) => (
        <span className={t.lineFx} key={line.id}
          style={{ left: `${line.box.x}px`, top: `${line.box.y}px`, inlineSize: `${line.box.w}px`, blockSize: `${line.box.h}px`, "--reach": `${line.box.x}px` } as CSSProperties}>
          <span className={t.lineTag} data-t={`lb-${line.id}`}>
            {tagSteps(line, copy, compact).map((text, k) => <span className={t.lineTagStep} data-t={`lb-${line.id}-${k}`} key={k}><Tag>{text}</Tag></span>)}
          </span>
          <span className={t.lineLeader} data-t={`ll-${line.id}`} />
          <span className={t.lineBand} data-t={`lband-${line.id}`} />
          <span className={t.lineMeasure} data-t={`lm-${line.id}`} />
          {line.draw ? (
            <svg className={t.lineSvg} data-t={`ls-${line.id}`} height={line.box.h} width={line.box.w}>
              <text className={t.lineOutline} data-t={`lo-${line.id}`} x={0} y={line.baseline} style={{ "--dash": `${lineDash(line)}px` } as CSSProperties}
                fontFamily={line.font.family} fontSize={line.font.size} fontWeight={line.font.weight} stroke={line.font.color}>
                {line.text}
              </text>
            </svg>
          ) : null}
        </span>
      ))}
    </span>
  );
}
