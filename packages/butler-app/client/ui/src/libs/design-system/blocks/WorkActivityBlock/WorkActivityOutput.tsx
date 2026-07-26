import type { ReactNode } from "react";
import styles from "./WorkActivityBlock.module.css";

export function WorkActivityOutput({ children }: { children: ReactNode }) {
  return <pre className={styles.output}>{children}</pre>;
}
