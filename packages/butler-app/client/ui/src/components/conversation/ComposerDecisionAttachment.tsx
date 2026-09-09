import { FileText, Typo } from "@/butler-ds";
import styles from "./ComposerPlanInstructionContext.module.css";

export function ComposerDecisionAttachment({ title, label, onShowDecision }: {
  title: string; label: string; onShowDecision: () => void;
}) {
  return <div className={styles.wrap}>
    <button className={styles.document} onClick={onShowDecision} type="button" aria-label={title}>
      <FileText aria-hidden="true" size={13} />
      <span className={styles.title}>{title}</span>
      <Typo.Caption className={styles.status}>{label}</Typo.Caption>
    </button>
  </div>;
}
