import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ListRow.module.css";
import { dsClass } from "../../lib/internal";

export interface ListRowProps extends DsPrivateStyleProps {
  /** Icon element */
  icon?: ReactNode;
  /** Row title */
  title: string;
  /** Optional description */
  description?: string;
  /** A short status `Tag` after the title (e.g. Taken down). When the title and tag don't fit on one line, the tag moves under the title; the title never gives way to it. */
  tag?: ReactNode;
  /** Optional metadata (date, size, etc.) */
  meta?: string;
}

export function ListRow({
  icon,
  title,
  description,
  tag,
  meta,
  className,
}: ListRowProps) {
  const titleElement = <Typo.Body className={dsClass(styles.title)}>{title}</Typo.Body>;
  return (
    <div className={cn(styles.row, icon && styles.withIcon, className)}>
      {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
      <Stack gap="xs" className={dsClass(styles.content)}>
        <div className={styles.heading}>
          {tag == null ? titleElement : (
            <div className={styles.titleGroup}>
              {titleElement}
              <span className={styles.tag}>{tag}</span>
            </div>
          )}
          {meta && <Typo.Caption className={dsClass(styles.meta)}>{meta}</Typo.Caption>}
        </div>
        {description && (
          <Typo.Caption className={dsClass(styles.description)}>{description}</Typo.Caption>
        )}
      </Stack>
    </div>
  );
}
