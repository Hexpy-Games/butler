import type { ReactNode } from "react";
import { Typo } from "@/butler-ds";
import styles from "./ComposerDecisionSurface.module.css";

/** Shared Composer layout; each decision keeps its own domain action. */
export function ComposerDecisionSurface({ icon, title, onOpen, actions, error, testClass, aside }: {
  icon: ReactNode; title: string; onOpen: () => void; actions: ReactNode;
  error?: string; testClass: string;
  aside?: ReactNode;
}) {
  return (
    <div className={styles.surface} data-test-class={testClass}>
      <div className={styles.subject}>
        {icon}
        <button className={styles.title} onClick={onOpen} type="button" title={title}>{title}</button>
        {aside}
      </div>
      {error ? (
        <div className={styles.error}>
          <Typo.Caption as="p" tone="secondary" role="alert">{error}</Typo.Caption>
        </div>
      ) : null}
      <div className={styles.actions}>{actions}</div>
    </div>
  );
}
