import styles from "./ChangedLineDiff.module.css";

export interface ChangedLineDiffLine {
  type: "added" | "deleted";
  old_line?: number;
  new_line?: number;
  content: string;
}

export function ChangedLineDiff({
  ariaLabel,
  id,
  lines,
}: {
  ariaLabel: string;
  id: string;
  lines: readonly ChangedLineDiffLine[];
}) {
  return (
    <div aria-label={ariaLabel} className={styles.diff} id={id} role="region">
      {lines.map((line, index) => (
        <div
          className={line.type === "added" ? styles.added : styles.deleted}
          data-line-type={line.type}
          key={`${line.type}:${line.old_line ?? ""}:${line.new_line ?? ""}:${index}`}
        >
          <span className={styles.lineNumber}>{line.old_line ?? ""}</span>
          <span className={styles.lineNumber}>{line.new_line ?? ""}</span>
          <span aria-hidden="true" className={styles.marker}>
            {line.type === "added" ? "+" : "−"}
          </span>
          <code className={styles.content}>{line.content || " "}</code>
        </div>
      ))}
    </div>
  );
}
