import { useEffect, useState, type ReactNode } from "react";
import { appCopy } from "@/app/copy";
import { ArrowLeft, Box, Button, ButtonContainer, IconButton, PageContainer, ScrollArea, Separator, Stack, Typo, X } from "@/butler-ds";

export const FILE_VIEWER_PAGE_ID = "file-viewer-page";

/** Below this header width the actions show as icons (with tooltips) so name, actions and close keep one row. */
const COMPACT_HEADER_WIDTH = 480;

export interface FileViewerAction {
  id: string;
  label: string;
  /** Names the target too ("저장하기: 릴리스-노트.md"). */
  ariaLabel?: string;
  icon: ReactNode;
  /** Show the icon beside the label in the wide header too. */
  labelIcon?: boolean;
  run: () => void;
}

/**
 * The open file's row: its name and "size · time" (both truncate), then its actions and close, which never wrap
 * or shrink. In a narrow pane the actions are icon buttons with tooltips.
 */
export function FileViewerHeader({ title, meta, leading, actions = [], onClose, onBack }: {
  title: string; meta?: string; leading?: ReactNode; actions?: FileViewerAction[]; onClose: () => void;
  /** Back to the chat (the viewer took the whole workspace). */
  onBack?: () => void;
}) {
  const [node, ref] = useState<HTMLDivElement | null>(null);
  const compact = useCompactHeader(node);
  return <>
    <div ref={ref}>
      <Box paddingX="2xl" paddingY="md" data-test-class="file-viewer-header" data-compact={compact || undefined}>
        <Stack align="row" cross="center" gap="md" wrap={false}>
          {onBack ? <FileViewerBackButton onBack={onBack} /> : null}
          <Stack gap="none" grow basis="0" minWidth="0">
            <Typo.PanelTitle as="h2" truncate>{title}</Typo.PanelTitle>
            {meta ? <Typo.Caption tone="secondary" truncate>{meta}</Typo.Caption> : null}
          </Stack>
          {leading}
          <ButtonContainer size={compact ? "icon-sm" : "sm"} wrap={false} shrink={false}>
            {actions.map((action) => compact
              ? <IconButton key={action.id} label={action.label} aria-label={action.ariaLabel ?? action.label} data-test-class={`file-viewer-${action.id}`}
                onClick={action.run}>{action.icon}</IconButton>
              : <Button key={action.id} size="sm" variant="outline" iconStart={action.labelIcon ? action.icon : undefined} text={action.label}
                aria-label={action.ariaLabel} data-test-class={`file-viewer-${action.id}`} onClick={action.run} />)}
            <FileViewerCloseButton onClose={onClose} />
          </ButtonContainer>
        </Stack>
      </Box>
    </div>
    <Separator space="none" />
  </>;
}

/** Back to the chat, at the start of the open file's title row (the viewer took the whole workspace). */
export function FileViewerBackButton({ onBack }: { onBack: () => void }) {
  return <IconButton label={appCopy.fileViewer.backToChat} data-test-class="file-viewer-back" onClick={onBack}><ArrowLeft size="md" /></IconButton>;
}

/** Closes the open file, at the end of its title row. */
export function FileViewerCloseButton({ onClose }: { onClose: () => void }) {
  return <IconButton label={appCopy.fileViewer.close} data-test-class="file-viewer-close" onClick={onClose}><X size="md" /></IconButton>;
}

function useCompactHeader(node: HTMLElement | null): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry!.contentRect.width < COMPACT_HEADER_WIDTH));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return compact;
}

/**
 * The file as a reading page in the pane's one scroll: at most the 760px reading width, 48px in from the
 * pane's sides, under the header line and above the page end (PageContainer gutter plus Box padding).
 */
export function FileViewerPage({ children }: { children: ReactNode }) {
  return <ScrollArea fill dataTestClass="file-viewer-scroll">
    <PageContainer width="narrow" gutter="2xl" id={FILE_VIEWER_PAGE_ID} data-test-class="file-viewer-page">
      <Box paddingY="2xl"><Box padding="2xl">{children}</Box></Box>
    </PageContainer>
  </ScrollArea>;
}
