import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../Box";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { TintedGlass } from "./TintedGlass";

// #region recipe: Floating glass panel
function FloatingPanel() {
  return (
    <TintedGlass radius="popover" padding="md">
      <Stack gap="xs">
        <Typo.PanelTitle>Access</Typo.PanelTitle>
        <Typo.Caption tone="secondary">Butler asks before editing files or running commands.</Typo.Caption>
      </Stack>
    </TintedGlass>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The translucent, tinted surface for floating layers over the conversation.",
  whenToUse: ["A custom floating layer that is not already a DS overlay"],
  whenNotToUse: [
    { when: "A menu, popover, dialog or tooltip", use: "Popover" },
    { when: "An opaque card or panel on the page", use: "Box" },
    { when: "The message composer", use: "ComposerCard" },
  ],
  recipes: [{ name: "Floating glass panel", description: "radius and padding come from the glass scale; tint and edge follow the theme.", render: () => <FloatingPanel /> }],
  doDont: [
    {
      do: { caption: "Glass for layers that float above moving content.", render: () => <FloatingPanel /> },
      dont: { caption: "Glass for page content lowers contrast for no reason.", render: () => <Box padding="md" surface="raised" radius="panel"><Typo.Body>Page content stays opaque</Typo.Body></Box> },
    },
  ],
  content: ["No copy of its own; keep text on glass short."],
  accessibility: ["The tint keeps text contrast in both themes; do not lower --tinted-glass-tint."],
  tokens: ["--tinted-glass-bg", "--tinted-glass-tint", "--tinted-glass-filter", "--tinted-glass-shadow", "--tinted-glass-edge-size"],
};
