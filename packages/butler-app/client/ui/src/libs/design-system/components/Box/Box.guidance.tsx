import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../Card";
import { Typo } from "../Typo";
import { Box } from "./Box";

// #region recipe: Inset hint under a heading
function InsetHint() {
  return (
    <Box paddingX="sm">
      <Typo.Caption as="p" tone="secondary">Star a conversation or folder to keep it here.</Typo.Caption>
    </Box>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One surface: padding, radius, background and border from tokens, with no tone or behavior.",
  whenToUse: ["Inset content by a token step", "Give a region a muted or raised surface with a hairline"],
  whenNotToUse: [
    { when: "A card that can be selected or clicked", use: "Card" },
    { when: "A floating translucent surface", use: "TintedGlass" },
    { when: "A settings or inspector panel", use: "SurfacePanel" },
  ],
  recipes: [{ name: "Inset hint under a heading", description: "paddingX aligns text with rows that have their own inline padding.", render: () => <InsetHint /> }],
  doDont: [
    {
      do: { caption: "Box for padding and a surface; content decides the rest.", render: () => <Box padding="md" surface="muted" radius="panel"><Typo.Body>Muted surface</Typo.Body></Box> },
      dont: { caption: "Card when nothing is a card: it adds shadow and selection semantics.", render: () => <Card><Typo.Body>Not really a card</Typo.Body></Card> },
    },
  ],
  content: ["paddingStart indents one side (an indented row); windowDrag marks desktop drag regions.", "surface=raised-opaque and elevation=card reproduce the setup wizard solid card.", "No copy of its own."],
  accessibility: ["Box is a div by default; pass as=\"section\" or \"aside\" for landmarks."],
  tokens: ["--space-sm", "--radius-panel", "--surface-raised", "--line"],
};
