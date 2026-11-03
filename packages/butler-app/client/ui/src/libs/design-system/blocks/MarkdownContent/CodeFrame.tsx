import type { HTMLAttributes } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import styles from "./CodeFrame.module.css";

/** The code frame alone (border, radius, raised surface): MarkdownCodeFrame adds its header bar; a ComposerDecisionPanel `{ code }` detail uses it bare. */
export function CodeFrame({ className, ...props }: DsBaseProps<HTMLAttributes<HTMLDivElement>>) {
  return <div className={dsClass(styles.frame, className)} {...props} />;
}
