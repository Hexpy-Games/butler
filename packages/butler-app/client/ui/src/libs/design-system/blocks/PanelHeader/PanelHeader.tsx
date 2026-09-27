import type { DsPrivateStyleProps } from "../../lib/dsProps";
import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./PanelHeader.module.css";
import { dsClass } from "../../lib/internal";

export interface PanelHeaderProps extends DsPrivateStyleProps {
  /** Panel title */
  title: string;
  /** Optional description or subtitle */
  description?: string;
  /** Action buttons */
  actions?: ReactNode;
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: PanelHeaderProps) {
  return (
    <Stack align="row" justify="between" cross="center" className={dsClass(styles.header, className)}>
      <Stack gap="xs" className={dsClass(styles.text)}>
        <Typo.PanelTitle className={dsClass(styles.title)}>{title}</Typo.PanelTitle>
        {description && (
          <Typo.Caption className={dsClass(styles.description)}>{description}</Typo.Caption>
        )}
      </Stack>
      {actions && <div className={styles.actions}>{actions}</div>}
    </Stack>
  );
}
