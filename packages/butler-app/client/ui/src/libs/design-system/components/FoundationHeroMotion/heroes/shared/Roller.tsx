import type { CSSProperties } from "react";
import type { Key, Track } from "../../heroTimeline";
import { select } from "./Reveal";
import c from "./ChapterHero.module.css";

const DIGITS = [" ", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

type Column = { kind: "roll"; chars: string[] } | { kind: "fixed"; char: string } | { kind: "cut"; chars: string[] };

/** Right-aligned columns of a readout over its values: digits roll on strips, equal characters stay, the rest cut. */
function columns(values: string[]): Column[] {
  const width = Math.max(...values.map((value) => [...value].length));
  const padded = values.map((value) => [...value.padStart(width, " ")]);
  return Array.from({ length: width }, (_, k): Column => {
    const chars = padded.map((value) => value[k]!);
    if (chars.every((char) => char === chars[0])) return { kind: "fixed", char: chars[0]! };
    if (chars.every((char) => DIGITS.includes(char))) return { kind: "roll", chars };
    return { kind: "cut", chars };
  });
}

/**
 * A readout that changes with its control: digits roll through every value
 * between (tabular strips), other characters cut in place. The poster shows
 * value `poster`. `data-roller` lets the hero read its line height.
 */
export function Roller({ id, values, poster, className }: { id: string; values: string[]; poster: number; className?: string }) {
  return (
    <span className={`${c.roller} ${className ?? ""}`} data-roller={id}>
      {columns(values).map((column, k) => {
        if (column.kind === "fixed") return <span key={k}>{column.char === " " ? " " : column.char}</span>;
        if (column.kind === "roll") {
          return (
            <span className={c.digit} key={k}>
              <span className={c.digitStrip} data-t={`${id}-s${k}`} style={{ "--d": DIGITS.indexOf(column.chars[poster]!) } as CSSProperties}>
                {DIGITS.map((digit, n) => <span key={n}>{digit === " " ? " " : digit}</span>)}
              </span>
              <span className={c.digitSpace}>0</span>
            </span>
          );
        }
        return (
          <span className={c.cutCell} key={k}>
            {column.chars.map((char, n) => <span className={c.cutChar} data-last={n === poster ? "" : undefined} data-t={`${id}-c${k}-${n}`} key={n}>{char === " " ? " " : char}</span>)}
          </span>
        );
      })}
    </span>
  );
}

/**
 * The readout's motion: at each [beat, value] it rolls (digits, over `roll`
 * beats ending at the beat) or cuts to that value. `line` is its line height
 * (px); the poster value is where the strips rest without animation.
 */
export function rollerTracks(id: string, values: string[], poster: number, times: Array<[number, number]>, line: number, close: number, roll = 0.6): Track[] {
  const cols = columns(values);
  return cols.flatMap((column, k): Track[] => {
    if (column.kind === "fixed") return [];
    if (column.kind === "roll") {
      const rest = DIGITS.indexOf(column.chars[poster]!);
      const y = (value: number) => (rest - DIGITS.indexOf(column.chars[value]!)) * line;
      const keys: Key[] = [{ at: 0, y: y(times[0]![1]) }];
      times.slice(1).forEach(([at, value], j) => keys.push({ at: Math.max(times[j]![0] + 0.01, at - roll), y: y(times[j]![1]) }, { at, y: y(value), ease: "standard" }));
      keys.push({ at: close - 0.01 }, { at: close, y: y(times[0]![1]) });
      return [{ select: select(`${id}-s${k}`), keys }];
    }
    // One layer per value: the layer of the current value shows.
    return column.chars.map((_, n): Track => {
      const first = times[0]![1] === n ? 1 : 0;
      const keys: Key[] = [{ at: 0, o: first }];
      times.slice(1).forEach(([at, value]) => keys.push({ at: at - 0.01, o: keys.at(-1)!.o }, { at, o: value === n ? 1 : 0 }));
      keys.push({ at: close - 0.01 }, { at: close, o: first });
      return { select: select(`${id}-c${k}-${n}`), keys };
    });
  });
}
