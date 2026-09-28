import type { CSSProperties } from "react";
import { Tag } from "../../../Tag";
import type { TypeCopy } from "./typeCopy";
import type { LineInfo } from "./typeLines";
import t from "./TypographyHero.module.css";

/** Dash length that covers a line's outlines: generous per character, more for Hangul. */
export function lineDash(line: LineInfo): number {
  return [...line.text].reduce((sum, char) => sum + (/[ㄱ-힝]/u.test(char) ? 7 : 4), 0) * line.font.size;
}

/**
 * The build layer of one component: for each of its text lines, a badge with
 * the typography token the line is set in, a baseline rule that draws left to
 * right, and the line's own outline (the same font, size and weight as the
 * real text underneath, stroked and drawn along its contours) before the real
 * text fills in. Positions come from measuring the poster.
 */
export function LineOverlay({ lines, copy }: { lines: LineInfo[]; copy: TypeCopy }) {
  return (
    <span className={t.lines} aria-hidden="true">
      {lines.map((line) => (
        <span className={t.lineFx} data-t={`lx-${line.id}`} key={line.id}
          style={{ left: `${line.box.x}px`, top: `${line.box.y}px`, inlineSize: `${line.box.w}px`, blockSize: `${line.box.h}px` } as CSSProperties}>
          <span className={t.lineBadge} data-t={`lb-${line.id}`}><Tag>{`${copy.roles[line.role]} · ${line.token}`}</Tag></span>
          {line.draw ? (
            <>
              <span className={t.lineRule} data-t={`lr-${line.id}`} style={{ top: `${line.baseline}px` } as CSSProperties} />
              <svg className={t.lineSvg} height={line.box.h} width={line.box.w}>
                <text className={t.lineOutline} data-t={`lo-${line.id}`} x={0} y={line.baseline} style={{ "--dash": `${lineDash(line)}px` } as CSSProperties}
                  fontFamily={line.font.family} fontSize={line.font.size} fontWeight={line.font.weight} stroke={line.font.color}>
                  {line.text}
                </text>
              </svg>
            </>
          ) : null}
        </span>
      ))}
    </span>
  );
}
