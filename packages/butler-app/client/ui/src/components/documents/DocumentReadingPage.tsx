import { Box, PageContainer, ScrollArea } from "@/butler-ds";
import { DocumentPage } from "./DocumentPage";

/** The drawer owns the scrolling and reading column; DocumentPage is ready for any host. */
export function DocumentReadingPage({ id }: { id: string }) {
  return <ScrollArea fill>
    <PageContainer width="narrow" gutter="2xl" data-test-class="document-reading-page">
      <Box paddingY="2xl"><Box padding="2xl"><DocumentPage id={id} /></Box></Box>
    </PageContainer>
  </ScrollArea>;
}
