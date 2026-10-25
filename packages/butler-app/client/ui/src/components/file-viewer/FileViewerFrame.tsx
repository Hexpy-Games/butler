import type { ReactNode } from "react";
import { appCopy } from "@/app/copy";
import { Box, ButtonContainer, IconButton, PageContainer, ScrollArea, Separator, Stack, Typo, X } from "@/butler-ds";

export const FILE_VIEWER_PAGE_ID = "file-viewer-page";

/** The open file's row: its name, "type / size · time", its actions and close. */
export function FileViewerHeader({ title, meta, actions, onClose }: { title: string; meta?: string; actions?: ReactNode; onClose: () => void }) {
  return <>
    <Box paddingX="2xl" paddingY="md" data-test-class="file-viewer-header">
      <Stack align="row" cross="center" gap="md">
        <Stack gap="none" grow minWidth="0">
          <Typo.PanelTitle as="h2" truncate>{title}</Typo.PanelTitle>
          {meta ? <Typo.Caption tone="secondary" truncate>{meta}</Typo.Caption> : null}
        </Stack>
        <ButtonContainer size="sm" justify="end">
          {actions}
          <IconButton label={appCopy.fileViewer.close} data-test-class="file-viewer-close" onClick={onClose}><X size="md" /></IconButton>
        </ButtonContainer>
      </Stack>
    </Box>
    <Separator space="none" />
  </>;
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
