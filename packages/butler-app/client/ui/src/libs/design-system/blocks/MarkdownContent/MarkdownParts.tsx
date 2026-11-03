import type { ReactNode, TableHTMLAttributes } from "react";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { CodeFrame } from "./CodeFrame";
import styles from "./MarkdownContent.module.css";

export interface MarkdownCodeFrameProps {
  /** Language label shown in the header bar; empty keeps the bar. */
  language?: string;
  /** Header actions, usually one icon CopyButton. */
  actions?: ReactNode;
  /** The `<code>` element; syntax roles use `data-syntax` spans. */
  children: ReactNode;
}

/** Fenced code block: CodeFrame with a header bar (language + actions) over a horizontally faded `pre`. */
export function MarkdownCodeFrame({ language, actions, children }: MarkdownCodeFrameProps) {
  const preFadeRef = useScrollEdges("x");
  return (
    <CodeFrame className={dsClass(styles.codeFrame)} data-test-class="code-block">
      <div className={styles.codeHeader} data-test-class="code-block-header">
        <Typo.Code as="span" truncate>{language ?? ""}</Typo.Code>
        {actions}
      </div>
      <pre ref={preFadeRef} className={styles.codePre}>{children}</pre>
    </CodeFrame>
  );
}

/**
 * Markdown table with horizontal scroll edge fades. A react-markdown element
 * renderer: it receives the table attributes react-markdown produces, so it
 * keeps the plain table props (the one DS export exempt from DsBaseProps).
 */
export function MarkdownTable({
  node: _node,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { node?: unknown }) {
  const tableFadeRef = useScrollEdges("x");
  return <table ref={tableFadeRef} {...props} />;
}
