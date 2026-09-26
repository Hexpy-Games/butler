import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../../components/Box";
import { Typo } from "../../components/Typo";
import { AdaptiveShell, AdaptiveShellInspector, AdaptiveShellScrim, AdaptiveShellSidebar, AdaptiveShellWorkspace } from "./index";

// #region recipe: App frame
function AppFrame() {
  return (
      <AdaptiveShell leftOpen rightOpen={false} compactSidebarFullWidth>
        <AdaptiveShellSidebar open><Box padding="md"><Typo.PanelTitle>Navigation</Typo.PanelTitle></Box></AdaptiveShellSidebar>
        <AdaptiveShellWorkspace><Box padding="md"><Typo.AppTitle>Conversation</Typo.AppTitle></Box></AdaptiveShellWorkspace>
        <AdaptiveShellInspector open={false}><Box padding="md"><Typo.PanelTitle>Inspector</Typo.PanelTitle></Box></AdaptiveShellInspector>
        <AdaptiveShellScrim label="Close panel" open={false} onDismiss={() => undefined} />
      </AdaptiveShell>
  );
}
// #endregion

/** Viewer frame only: paint containment keeps the shell's fixed drawers in the preview. */
function Framed() {
  return <div style={{ height: 240, contain: "layout paint" }}><AppFrame /></div>;
}

export const guidance: ShowcaseGuidance = {
  purpose: "The app frame: sidebar, workspace and inspector that become drawers over a scrim on compact widths.",
  whenToUse: ["The root layout of the app window (AppShell)"],
  whenNotToUse: [
    { when: "A page inside the workspace", use: "PageContainer" },
    { when: "A static preview of the chrome", use: "ChromeFrame" },
  ],
  recipes: [{ name: "App frame", description: "The frame is bounded here for the preview; in the app it fills the window.", render: () => <Framed /> }],
  doDont: [
    {
      do: { caption: "Panels open and close through leftOpen/rightOpen; the shell animates them.", render: () => <Framed /> },
      dont: { caption: "Media queries in product CSS fork the breakpoints the shell already owns.", render: () => <Typo.Code>@media (width &lt;= 768px) {"{ .sidebar { … } }"}</Typo.Code> },
    },
  ],
  content: ["The scrim label is a verb: Close panel."],
  accessibility: ["The scrim is a button only while open; drawers keep focus order sidebar → workspace → inspector."],
  tokens: ["--adaptive-drawer-width", "--adaptive-inspector-width", "--adaptive-panel-duration", "--adaptive-scrim-bg", "--sidebar-width"],
};
