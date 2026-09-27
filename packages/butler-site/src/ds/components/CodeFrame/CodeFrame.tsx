import type { ReactNode } from "react";
import { Button } from "../Button";
import { Check, Copy } from "../Icons";
import { Typo } from "../Typo";
import styles from "./CodeFrame.module.css";

export interface CodeFrameProps {
  /** Language label in the header bar; empty keeps the bar. */
  language?: string;
  /** Accessible name of the copy button. */
  copyLabel?: string;
  /** The highlighted `<code>` element; syntax roles use `data-syntax` spans. */
  children: ReactNode;
}

/**
 * Code block: header bar (language + copy) over a horizontally faded `pre`.
 * Highlighting happens at build time (lib/highlight.ts); codeFrame.client.ts
 * wires the copy button.
 */
export function CodeFrame({ language = "", copyLabel = "코드 복사", children }: CodeFrameProps) {
  return (
    <div className={styles.frame} data-slot="code-frame">
      <div className={styles.header} data-pagefind-ignore>
        <Typo.Code as="span" truncate>{language}</Typo.Code>
        <Button aria-label={copyLabel} data-code-copy="" size="icon-sm" title={copyLabel} variant="ghost">
          <span className={styles.copy}><Copy size="sm" /></span>
          <span className={styles.copied}><Check size="sm" /></span>
        </Button>
      </div>
      <pre className={styles.pre} data-scroll-fade="x" tabIndex={0}>{children}</pre>
    </div>
  );
}
