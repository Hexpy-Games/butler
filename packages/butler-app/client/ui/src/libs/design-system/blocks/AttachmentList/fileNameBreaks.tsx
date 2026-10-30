import { Fragment, type ReactNode } from "react";
import styles from "./AttachmentTiles.module.css";

/** A break never leaves fewer characters than this on either side, so no line holds an orphaned character. */
const MIN_PART = 2;
/** The end of a part that never wraps on its own: a part too long for one line breaks before it. */
const TAIL = 3;

const chars = (text: string) => [...text.replace(/[_\- ]$/u, "")].length;

/**
 * A file name with soft break opportunities after `_`, `-` and spaces and before the extension, so a clamped name
 * wraps at its own boundaries instead of inside a word. A part shorter than two characters stays with its neighbour,
 * and a part too long for one line keeps its last characters together.
 */
export function breakableName(name: string): ReactNode {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const parts = stem.split(/(?<=[_\- ])/u);
  if (dot > 0) parts.push(name.slice(dot));
  const merged: string[] = [];
  for (const part of parts) {
    const last = merged.at(-1);
    if (last !== undefined && (chars(part) < MIN_PART || chars(last) < MIN_PART)) merged[merged.length - 1] = last + part;
    else merged.push(part);
  }
  return merged.map((part, index) => {
    const letters = [...part];
    const cut = letters.length - TAIL - (/[_\- ]$/u.test(part) ? 1 : 0);
    return (
      <Fragment key={index}>
        {index > 0 ? <wbr /> : null}
        {cut > MIN_PART ? <>{letters.slice(0, cut).join("")}<span className={styles.nameTail}>{letters.slice(cut).join("")}</span></> : part}
      </Fragment>
    );
  });
}
