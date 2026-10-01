import type { HTMLAttributes, ReactNode, Ref } from "react";
import { IconSlot } from "../components/IconSlot";
import { Inline } from "../components/Inline";
import { Stack } from "../components/Stack";
import { Typo } from "../components/Typo";
import { ScrollArea } from "../blocks/ScrollArea";
import type { DsBaseProps } from "./dsProps";
import { dsClass } from "./internal";
import styles from "./composerPanel.module.css";

/** Private composition shared by the question and approval blocks. */
export function ComposerPanelFrame({ panelRef, className, ...props }: DsBaseProps<HTMLAttributes<HTMLDivElement>> & { panelRef?: Ref<HTMLDivElement> }) {
  return <div ref={panelRef} className={dsClass(styles.surface, className)} {...props} />;
}
export function ComposerPanelHeader({ icon, eyebrow, title, aside, tabbed = false, dataSlot, hasDetails }: {
  icon: ReactNode; eyebrow?: string; title: ReactNode; aside?: ReactNode; tabbed?: boolean; dataSlot?: string; hasDetails?: boolean;
}) {
  return <Inline className={dsClass(styles.subject)} cross="start" wrap={false} data-tabbed={tabbed} data-slot={dataSlot} data-has-details={hasDetails || undefined}>
    <IconSlot className={dsClass(styles.icon)} size="sm" minHeight="line" tone="secondary">{icon}</IconSlot>
    <Stack grow minWidth="0" gap="none">
      {eyebrow && <Typo.Caption tone="tertiary">{eyebrow}</Typo.Caption>}
      {title}
    </Stack>
    {aside && <div className={styles.aside} data-slot="composer-decision-aside">{aside}</div>}
  </Inline>;
}
export function ComposerPanelBody({ children, dataSlot, single = false }: { children: ReactNode; dataSlot: string; single?: boolean }) {
  return <div className={styles.body}><ScrollArea maxHeight="xs" dataSlot={dataSlot} contentClassName={single ? dsClass(styles.singleContent) : undefined}>
    <div className={styles.scrollContent}>{children}</div>
  </ScrollArea></div>;
}
export function ComposerPanelActions({ children, dataSlot }: { children: ReactNode; dataSlot?: string }) {
  return <div className={styles.actions} data-slot={dataSlot}>{children}</div>;
}
