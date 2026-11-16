import { Box, PageContainer, ScrollArea, Stack } from "@/butler-ds";
import { FileViewerTitleBand } from "../file-viewer/FileViewerFrame";
import { DocumentPage } from "./DocumentPage";

/** The drawer owns the scrolling and reading column; DocumentPage is ready for any host. */
export function DocumentReadingPage({ id }: { id: string }) {
  return <DocumentPage id={id} frame={(header, body) => <Stack fill gap="none"><FileViewerTitleBand width="narrow">{header}</FileViewerTitleBand><ScrollArea fill>
    <PageContainer width="narrow" gutter="2xl" data-test-class="document-reading-page">
      <Box paddingY="2xl"><Box padding="2xl">{body}</Box></Box>
    </PageContainer>
  </ScrollArea></Stack>} />;
}
