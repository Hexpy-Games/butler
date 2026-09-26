import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../Box";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { PageContainer } from "./PageContainer";

// #region recipe: Reading-width page
function ReadingPage() {
  return (
    <PageContainer width="narrow" align="start">
      <Stack gap="md">
        <Typo.H2>General</Typo.H2>
        <Typo.Body>Settings pages stay at reading width and start-aligned beside the navigation.</Typo.Body>
      </Stack>
    </PageContainer>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Caps a page's width (narrow, default, full) with the adaptive gutter and optional start alignment.",
  whenToUse: ["The outer frame of a settings, dashboard or document page"],
  whenNotToUse: [
    { when: "Spacing inside a page", use: "Stack" },
    { when: "A padded surface", use: "Box" },
  ],
  recipes: [{ name: "Reading-width page", description: "narrow = --page-max-width-reading; align=\"start\" for settings detail.", render: () => <ReadingPage /> }],
  doDont: [
    {
      do: { caption: "PageContainer owns max-width and gutters.", render: () => <ReadingPage /> },
      dont: { caption: "A padded Box has no page max-width or gutters.", render: () => <Box padding="xl"><Typo.Body>Custom width</Typo.Body></Box> },
    },
  ],
  content: ["No copy of its own."],
  accessibility: ["as=\"main\" for the primary page region (once per screen)."],
  tokens: ["--page-max-width-reading", "--page-max-width-wide", "--page-container-gutter"],
};
