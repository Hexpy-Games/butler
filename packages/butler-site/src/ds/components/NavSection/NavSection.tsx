import type { ReactNode } from "react";
import { Typo } from "../Typo";
import styles from "./NavSection.module.css";

export interface NavSectionProps {
  /** Section title; also names the list for assistive technology. */
  title: string;
  /** Hide the visible heading (a one-page section whose row repeats it). */
  hideTitle?: boolean;
  /** NavRow elements; each is wrapped in a list item. */
  rows: ReactNode[];
}

export function NavSection({ title, hideTitle = false, rows }: NavSectionProps) {
  return (
    <section aria-label={title} className={styles.section} data-slot="nav-section">
      {hideTitle ? null : (
        <div className={styles.header}>
          <span className={styles.title}><Typo.SectionTitle>{title}</Typo.SectionTitle></span>
        </div>
      )}
      <ul className={styles.rows}>
        {rows.map((row, index) => <li key={index}>{row}</li>)}
      </ul>
    </section>
  );
}
