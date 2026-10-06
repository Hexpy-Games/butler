import type { ReactNode } from "react";
import { ExternalReference, type ExternalReferenceProps } from "./ExternalReference";
import styles from "./InlineReference.module.css";

/** A conversation or document mention (the default kind). */
export interface InlineMentionProps {
  kind?: "reference";
  icon: ReactNode;
  children: ReactNode;
  unavailable?: boolean;
  onClick?: () => void;
}

/** An external http(s) link in running text. */
export interface InlineExternalProps extends ExternalReferenceProps {
  kind: "external";
}

export type InlineReferenceProps = InlineMentionProps | InlineExternalProps;

export function InlineReference(props: InlineReferenceProps) {
  if (props.kind === "external") {
    return <ExternalReference href={props.href} iconSrc={props.iconSrc}>{props.children}</ExternalReference>;
  }
  const { icon, children, unavailable = false, onClick } = props;
  const contents = <><span className={styles.icon}>{icon}</span><span>{children}</span></>;
  return onClick ? <button type="button" className={styles.reference} data-unavailable={unavailable} onClick={onClick}>{contents}</button>
    : <span className={styles.reference} data-unavailable={unavailable} aria-disabled={unavailable || undefined}>{contents}</span>;
}
