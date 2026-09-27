import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { DsBaseProps } from "../../lib/dsProps";
import { PillButton } from "../../components/PillButton";
import { Typo } from "../../components/Typo";
import styles from "./StatusCapsule.module.css";

export interface StatusCapsuleProps extends Omit<DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>>, "children" | "title"> {
  /** Leading mark (an animated thinking mark, a spinner). */
  icon?: ReactNode;
  /** What the work is; truncates first. */
  title: string;
  /** What it is doing now (secondary). */
  detail?: string;
  /** Step count such as 2/3 (tabular). */
  progress?: string;
  /** `data-test-class` values for the parts (tests and smokes). */
  partTestClasses?: { title?: string; detail?: string; progress?: string };
}

/**
 * A glass pill that summarizes running work above the composer:
 * title · detail · progress, each part truncating within its own cap.
 */
export function StatusCapsule({ icon, title, detail, progress, partTestClasses, type = "button", ...props }: StatusCapsuleProps) {
  return (
    <PillButton surface="glass" icon={icon} title={title} type={type} {...props}>
      <span className={styles.content} data-slot="status-capsule-content">
        <span className={styles.title} data-test-class={partTestClasses?.title}>{title}</span>
        {detail ? (
          <>
            <Typo.Text aria-hidden="true" tone="tertiary" wrap="nowrap">·</Typo.Text>
            <span className={styles.detail} data-test-class={partTestClasses?.detail}>{detail}</span>
          </>
        ) : null}
        {progress ? (
          <>
            <Typo.Text aria-hidden="true" tone="tertiary" wrap="nowrap">·</Typo.Text>
            <Typo.Text data-test-class={partTestClasses?.progress} numeric="tabular" tone="tertiary" wrap="nowrap">
              {progress}
            </Typo.Text>
          </>
        ) : null}
      </span>
    </PillButton>
  );
}
