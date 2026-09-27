import type { ReactNode } from "react";
import { MarkdownCodeFrame, MarkdownContent } from "../blocks/MarkdownContent";
import { MessageFooter } from "../blocks/MessageRow";
import { CopyButton } from "../components/CopyButton";
import { Stack } from "../components/Stack";
import { Tag } from "../components/Tag";
import { Typo } from "../components/Typo";
import styles from "./DesignSystemViewer.module.css";

/** Editorial page header: eyebrow, title, lead paragraph, optional actions. */
export function PageHeader({ eyebrow, title, lead, children }: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Stack gap="md">
      {eyebrow ? <Stack align="row"><Tag tone="accent" size="md">{eyebrow}</Tag></Stack> : null}
      <Typo.H1>{title}</Typo.H1>
      {lead ? <p className={styles.lead}>{lead}</p> : null}
      {children}
    </Stack>
  );
}

/** Verbatim code with a copy action (MarkdownCodeFrame, as in chat answers). */
export function CodeSample({ code, language = "tsx" }: { code: string; language?: string }) {
  return (
    <MarkdownContent>
      <MarkdownCodeFrame language={language} actions={(
        <MessageFooter><CopyButton text={code} label="Copy code" copiedLabel="Copied" /></MessageFooter>
      )}>
        <code>{code}</code>
      </MarkdownCodeFrame>
    </MarkdownContent>
  );
}

/** Section anchor used by in-page tables of contents and search deep links. */
export function anchorId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}
