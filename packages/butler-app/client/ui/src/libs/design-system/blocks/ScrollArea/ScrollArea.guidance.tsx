import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../../components/Box";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ScrollArea } from "./ScrollArea";

const ROWS = Array.from({ length: 10 }, (_, index) => `Turn ${index + 1}: read the settings pages.`);

// #region recipe: Bounded transcript
function Transcript() {
  return (
    <ScrollArea style={{ height: 160 }}>
      <Stack gap="sm">{ROWS.map((row) => <Typo.Body key={row}>{row}</Typo.Body>)}</Stack>
    </ScrollArea>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A scroll container with the shared edge fades and thin scrollbars on its scrolling axis.",
  whenToUse: ["Any region that scrolls inside a fixed height or width"],
  whenNotToUse: [
    { when: "The whole page scrolls", use: "ManagementPage" },
    { when: "A sidebar list", use: "SidebarShell" },
  ],
  recipes: [{ name: "Bounded transcript", description: "Give it a height (or fill) and the fades follow the scroll position.", render: () => <Transcript /> }],
  doDont: [
    {
      do: { caption: "Fades only on edges that still have content.", render: () => <Transcript /> },
      dont: { caption: "overflow: auto on a Box has no fade affordance.", render: () => <Box style={{ height: 80, overflow: "auto" }}><Stack gap="sm">{ROWS.map((row) => <Typo.Body key={row}>{row}</Typo.Body>)}</Stack></Box> },
    },
  ],
  content: ["No copy of its own."],
  accessibility: ["Scrollable regions that hold focusable content need no tabIndex; otherwise give them a label and tabIndex=0."],
  tokens: ["--scroll-fade-size"],
};
