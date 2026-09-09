import type { ReactNode } from "react";
import { ScrollArea } from "../ScrollArea";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./DocumentReader.module.css";

export interface DocumentReaderProps {
  header: ReactNode;
  facts: Array<{ id: string; label: string; value: ReactNode }>;
  children: ReactNode;
  details?: ReactNode;
  hint?: string;
  action?: ReactNode;
}

/** Read-only document or artifact composition; the caller owns Dialog semantics. */
export function DocumentReader({ header, facts, children, details, hint, action }: DocumentReaderProps) {
  return (
    <div className={styles.reader}>
      <div className={styles.header}>{header}</div>
      <ScrollArea className={styles.scroller} contentClassName={styles.scrollContent}>
        {facts.length > 0 && <dl className={styles.facts}>
          {facts.map((fact) => <div key={fact.id} className={styles.fact}>
            <dt><Typo.Caption>{fact.label}</Typo.Caption></dt>
            <dd><Typo.Body as="div">{fact.value}</Typo.Body></dd>
          </div>)}
        </dl>}
        <Stack gap="lg" className={styles.body}>{children}{details}</Stack>
      </ScrollArea>
      {(hint || action) && <div className={styles.footer}>
        {hint && <Typo.Caption className={styles.hint}>{hint}</Typo.Caption>}
        {action}
      </div>}
    </div>
  );
}
