import type { ReactNode } from "react";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import styles from "./Tag.module.css";

interface TagProps {
  children: ReactNode;
  icon?: ReactNode;
  ariaLabel?: string;
}

export function Tag({ children, icon, ariaLabel }: TagProps) {
  return (
    <Stack
      align="row"
      cross="center"
      gap="xs"
      className={styles.tag}
      aria-label={ariaLabel}
    >
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <Typo.Caption className={styles.label}>{children}</Typo.Caption>
    </Stack>
  );
}
