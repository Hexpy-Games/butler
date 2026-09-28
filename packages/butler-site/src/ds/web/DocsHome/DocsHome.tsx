import { navBlocks, type NavSectionItem } from "../../../site/nav";
import { Card } from "../../components/Card";
import { NavRow } from "../../components/NavRow";
import { Typo } from "../../components/Typo";
import styles from "./DocsHome.module.css";

export interface DocsHomeProps {
  sections: NavSectionItem[];
  plannedBadge: string;
  plannedReason: string;
}

/** The docs map: each section (one-page sections grouped) as a card of its pages. */
export function DocsHome({ sections, plannedBadge, plannedReason }: DocsHomeProps) {
  return (
    <div className={styles.grid}>
      {navBlocks(sections).map((block) => (
        <Card key={block.key} padding="sm">
          <section aria-label={block.title} className={styles.section}>
            <span className={styles.title}><Typo.SectionTitle tone="tertiary">{block.title}</Typo.SectionTitle></span>
            <ul className={styles.rows}>
              {block.sections.flatMap((section) => section.rows).map((row) => (
                <li key={row.slug}>
                  <NavRow
                    badge={row.planned ? plannedBadge : undefined}
                    disabledReason={row.planned ? plannedReason : undefined}
                    href={row.href}
                    label={row.label}
                  />
                </li>
              ))}
            </ul>
          </section>
        </Card>
      ))}
    </div>
  );
}
