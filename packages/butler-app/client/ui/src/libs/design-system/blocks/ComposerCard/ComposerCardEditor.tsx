import type { ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";
import styles from "./ComposerCard.module.css";

export function ComposerCardEditor({ children }: { children: ReactNode }) {
  return <div className={styles.editor}>{children}</div>;
}

export function ComposerCardEditable({ children }: { children: ReactNode }) {
  return <Slot className={styles.textarea}>{children}</Slot>;
}

export function ComposerCardPlaceholder({ children }: { children: ReactNode }) {
  return <div className={styles.editorPlaceholder} aria-hidden="true">{children}</div>;
}
