import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./NavSection.module.css";
import { dsClass } from "../../lib/internal";

/** The shared heading can sit outside a separately scrolling navigation list. */
export function NavSectionHeading({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <Stack
      align="row"
      justify="between"
      cross="center"
      className={dsClass(styles.header)}
    >
      <Typo.SectionTitle className={dsClass(styles.title)}>{title}</Typo.SectionTitle>
      {actions && (
        <Stack align="row" gap="xs" cross="center" className={dsClass(styles.actions)}>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
