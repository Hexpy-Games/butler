import type { HTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { Typo } from "../../components/Typo";
import { CheckIndicator } from "../CheckCard/CheckIndicator";
import styles from "./StatusChecklist.module.css";

export interface StatusChecklistItem {
  /** The item's text; one or more lines. */
  text: ReactNode;
  done: boolean;
}

export interface StatusChecklistProps extends DsBaseProps<HTMLAttributes<HTMLUListElement>> {
  items: StatusChecklistItem[];
}

/**
 * A read-only checklist: CheckCard's round indicator beside each item's text, done items in the
 * secondary tone. Nothing is interactive; each row is a read-only checkbox to assistive tech.
 */
export function StatusChecklist({ items, className, ...props }: StatusChecklistProps) {
  return (
    <ul {...props} className={dsClass(styles.list, className)} data-slot="status-checklist">
      {items.map((item, index) => (
        <li key={index}>
          <span aria-checked={item.done} aria-readonly="true" className={styles.item} data-done={item.done ? "true" : undefined} role="checkbox">
            <span className={styles.indicator}><CheckIndicator checked={item.done} /></span>
            <Typo.Body as="span" tone={item.done ? "secondary" : "primary"}>{item.text}</Typo.Body>
          </span>
        </li>
      ))}
    </ul>
  );
}
