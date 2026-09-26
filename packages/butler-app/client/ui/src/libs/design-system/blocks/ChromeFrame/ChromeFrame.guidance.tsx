import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../../components/Box";
import { IconButton } from "../../components/IconButton";
import { PanelLeft } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { ChromeFloatingToggleLayer, ChromeFrame } from "./ChromeFrame";

// #region recipe: Window chrome with a collapsed sidebar
function CollapsedChrome() {
  return (
    <ChromeFrame leftCollapsed titlebar={<Box padding="sm"><Typo.AppTitle>Token page review</Typo.AppTitle></Box>}
      sidebar={<Box padding="sm"><Typo.Caption>Sidebar</Typo.Caption></Box>}>
      <ChromeFloatingToggleLayer><IconButton label="Show left panel"><PanelLeft size="md" /></IconButton></ChromeFloatingToggleLayer>
      <Box padding="md"><Typo.Body>Conversation</Typo.Body></Box>
    </ChromeFrame>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The window chrome regions (sidebar, titlebar, main, inspector) with single-hairline joins and the floating toggle layer.",
  whenToUse: ["Frame app chrome where adjacent regions share an edge", "Place the floating sidebar toggle in the titlebar row"],
  whenNotToUse: [
    { when: "The responsive app layout with drawers", use: "AdaptiveShell" },
    { when: "The titlebar content itself", use: "TitlebarShell" },
  ],
  recipes: [{ name: "Window chrome with a collapsed sidebar", description: "Only one side of a shared edge draws the line.", render: () => <CollapsedChrome /> }],
  doDont: [
    {
      do: { caption: "ChromeFrame draws one hairline where regions meet.", render: () => <CollapsedChrome /> },
      dont: { caption: "Borders on both neighbors double the line.", render: () => <Box border="hairline"><Box border="hairline" padding="sm"><Typo.Caption>Double border</Typo.Caption></Box></Box> },
    },
  ],
  content: ["No copy of its own."],
  accessibility: ["The floating toggle is a regular IconButton with a label; regions keep landmark roles from their content."],
  tokens: ["--line", "--titlebar-height", "--chrome-floating-toggle-left", "--chrome-floating-toggle-top"],
};
