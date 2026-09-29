import type { CSSProperties } from "react";
import { Tag } from "../../../Tag";
import type { TypeCopy } from "./typeCopy";
import { TAG_GAP, TAG_ROW, type LineInfo } from "./typeLines";
import { Reveal } from "./Reveal";
import t from "./TypographyHero.module.css";

/** The tag's steps: the token, then its size, its line height, its tracking as each is applied. */
export function tagSteps(line: LineInfo, copy: TypeCopy, compact: boolean): string[] {
  const token = compact ? line.token : `${copy.roles[line.role]} · ${line.token}`;
  const size = `${Math.round(line.font.size)}px`;
  const leading = `${size}/${Math.round(line.font.lineHeight)}`;
  // Tracking only when the token sets some; zero or default values are not annotated.
  const tracked = Number.parseFloat(line.font.tracking) !== 0 && !Number.isNaN(Number.parseFloat(line.font.tracking));
  return [token, `${line.token} · ${size}`, `${line.token} · ${leading}`, ...(tracked ? [`${line.token} · ${leading} · ${line.font.tracking}`] : [])];
}

/** Width a line's reveal window covers (the ink may overhang the last advance a little). */
export function wipeWidth(line: LineInfo): number {
  return Math.ceil(Math.max(line.box.w, line.edges.at(-1) ?? 0) + line.font.size * 0.2);
}

/**
 * One layer of a line (outline or fill), shown through a window that opens
 * left to right glyph by glyph: the window (`w…-o`) and its content
 * (`w…-i`) move in opposite directions, so only the window's edge travels.
 */
function Layer({ line, name, fill }: { line: LineInfo; name: string; fill: boolean }) {
  return (
    <span className={t.wipe} data-t={`${name}-o-${line.id}`} style={{ "--wipe-w": `${wipeWidth(line)}px` } as CSSProperties}>
      <span className={t.wipeIn} data-t={`${name}-i-${line.id}`}>
        <svg className={t.lineSvg} height={line.box.h} width={wipeWidth(line)}>
          <text className={fill ? t.lineFill : t.lineOutline} x={0} y={line.baseline}
            fontFamily={line.font.family} fontSize={line.font.size} fontWeight={line.font.weight} fill={fill ? line.font.color : "none"} stroke={fill ? "none" : line.font.color}>
            {line.text}
          </text>
        </svg>
      </span>
    </span>
  );
}

/**
 * The build layer of one component, a pure overlay (absolute, no layout): for
 * each text line, a token tag far out in the frame gutter joined to the line
 * by a thin leader; the line's outline revealed glyph by glyph at a neutral
 * size, then set to its role size; its line box shown as a leading band with
 * a measure; the tag counting size, line height and tracking in; the glyphs
 * filled left to right; then the real text takes over and the guides recede.
 */
export function LineOverlay({ lines, copy, compact, height }: {
  lines: LineInfo[]; copy: TypeCopy; /** Token name only, tags stacked under the component (tall canvas). */ compact: boolean; /** The panel's height (px). */ height: number;
}) {
  const tagged = lines.filter((line) => !line.secondary);
  return (
    <span className={t.lines} aria-hidden="true">
      {lines.map((line) => (
        <span className={t.lineFx} key={line.id}
          style={{
            left: `${line.box.x}px`, top: `${line.box.y}px`, inlineSize: `${line.box.w}px`, blockSize: `${line.box.h}px`, "--reach": `${line.box.x}px`,
            // Tall: the tag's row under the component (px below this line's top).
            "--tag-top": `${height - line.box.y + TAG_GAP + tagged.indexOf(line) * TAG_ROW}px`,
          } as CSSProperties}>
          {line.secondary ? null : (
            <>
              <span className={t.lineTag} data-t={`lb-${line.id}`}>
                <Reveal name={`rv-lb-${line.id}`}>
                  <span className={t.lineTagSteps}>
                    {tagSteps(line, copy, compact).map((text, k) => <span className={t.lineTagStep} data-t={`lb-${line.id}-${k}`} key={k}><Tag>{text}</Tag></span>)}
                  </span>
                </Reveal>
              </span>
              <span className={t.lineLeader} data-t={`ll-${line.id}`} />
              <span className={t.lineBand} data-t={`lband-${line.id}`}><span className={t.bandIn} data-t={`lband-${line.id}-in`} /></span>
              <span className={t.lineMeasure} data-t={`lm-${line.id}`} />
            </>
          )}
          {line.draw ? (
            <span className={t.lineScale} data-t={`ls-${line.id}`}>
              {line.outlined ? <Layer fill={false} line={line} name="wo" /> : null}
              <Layer fill line={line} name="wf" />
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}
