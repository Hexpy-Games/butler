import { navBlocks, type NavSectionItem } from "../../../site/nav";
import { NavRow } from "../../components/NavRow";
import { NavSection } from "../../components/NavSection";
import styles from "./SidebarNav.module.css";

export interface SidebarNavProps {
  sections: NavSectionItem[];
  plannedBadge: string;
  plannedReason: string;
}

/** The docs IA as DS NavSections; planned pages are disabled rows, never links. */
export function SidebarNav({ sections, plannedBadge, plannedReason }: SidebarNavProps) {
  return (
    <div className={styles.sections}>
      {navBlocks(sections).map((block) => (
        <NavSection
          hideTitle={block.hideTitle}
          key={block.key}
          rows={block.sections.flatMap((section) => section.rows).map((row) => (
            <NavRow
              active={row.active}
              badge={row.planned ? plannedBadge : undefined}
              disabledReason={row.planned ? plannedReason : undefined}
              href={row.href}
              label={row.label}
            />
          ))}
          title={block.title}
        />
      ))}
    </div>
  );
}
