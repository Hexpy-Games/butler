import type { ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { dsClass } from "../../lib/internal";
import styles from "./MessageRow.module.css";

/** Chronological message/activity rows belonging to one transcript group. */
export function MessageTurnGroup({ children }: { children: ReactNode }) {
  return <Stack gap="lg" className={dsClass(styles.turnGroup)}>{children}</Stack>;
}
