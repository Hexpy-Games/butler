import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../../components/Box";
import { Typo } from "../../components/Typo";
import { useRef } from "react";
import { TitlebarShell } from "../TitlebarShell";
import {
  AdaptiveShell, AdaptiveShellCard, AdaptiveShellInspector, AdaptiveShellPeekEdge, AdaptiveShellScrim, AdaptiveShellSidebar, AdaptiveShellSplit,
  AdaptiveShellTitle, AdaptiveShellWorkspace, useSidebarPeek,
} from "./index";

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

// #region recipe: Conversation frame with the browser pane
function ConversationFrame() {
  const shell = useRef<HTMLDivElement>(null);
  // Forward the host's "pointer entered the native view" signal to peek.pointerOutside().
  const peek = useSidebarPeek(shell, { enabled: true });
  return (
    <AdaptiveShell ref={shell} leftOpen={false} leftPeek={peek.open} rightOpen={false} splitOpen>
      <AdaptiveShellSidebar open={false}><Box padding="md"><Typo.PanelTitle>Navigation</Typo.PanelTitle></Box></AdaptiveShellSidebar>
      <AdaptiveShellPeekEdge onPeek={peek.show} />
      <AdaptiveShellWorkspace>
        <AdaptiveShellSplit paneOpen chatWidth={400} onChatWidthChange={() => undefined} resizeLabel="Resize conversation" resizeHint="Drag to resize"
          chat={<Box padding="md"><Typo.Body>Conversation</Typo.Body></Box>} pane={<Box padding="md"><Typo.Body>Browser pane</Typo.Body></Box>} />
      </AdaptiveShellWorkspace>
    </AdaptiveShell>
  );
}
// #endregion

// #region recipe: Cards frame
function CardsFrame() {
  return (
    <AdaptiveShell frame="cards" leftOpen rightOpen>
      <AdaptiveShellSidebar open><Box padding="md"><Typo.PanelTitle>Navigation</Typo.PanelTitle></Box></AdaptiveShellSidebar>
      <AdaptiveShellWorkspace>
        {/* The title row is the shell's: it spans the inspector's column, so its icons never move. */}
        <AdaptiveShellTitle><TitlebarShell title="Conversation" dragRegion dataTestClass="custom-titlebar" /></AdaptiveShellTitle>
        <AdaptiveShellCard><Box padding="md"><Typo.Body>Conversation</Typo.Body></Box></AdaptiveShellCard>
      </AdaptiveShellWorkspace>
      <AdaptiveShellInspector open><Box padding="md"><Typo.PanelTitle>Inspector</Typo.PanelTitle></Box></AdaptiveShellInspector>
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
  recipes: [
    { name: "App frame", description: "The frame is bounded here for the preview; in the app it fills the window.", render: () => <Framed /> },
    {
      name: "Conversation frame with the browser pane",
      description: "splitOpen keeps the inspector closed; the split sits under the titlebar; useSidebarPeek drives the peek edge and closes it (DOM signals plus the host's native-view signal).",
      render: () => <div style={{ height: 240, contain: "layout paint" }}><ConversationFrame /></div>,
    },
    {
      name: "Cards frame",
      description: "frame=\"cards\": one shell surface (sidebar, window chrome, title row); content in rounded cards. Put the TitlebarShell in AdaptiveShellTitle and the content in AdaptiveShellCard; the split, the standalone BrowserPane, the inspector and the settings detail draw their own cards.",
      render: () => <div style={{ height: 240, contain: "layout paint" }}><CardsFrame /></div>,
    },
  ],
  doDont: [
    {
      do: { caption: "Panels open and close through leftOpen/rightOpen; the shell animates them.", render: () => <Framed /> },
      dont: { caption: "Media queries in product CSS fork the breakpoints the shell already owns.", render: () => <Typo.Code>@media (width &lt;= 768px) {"{ .sidebar { … } }"}</Typo.Code> },
    },
  ],
  content: ["Resizable panel widths go through UNSAFE_style={adaptivePanelStyle(...)}; theme applies the app theme classes.",
    "The browser pane and the inspector are mutually exclusive (toggleConversationSidePanel); useSidebarAutoCollapse steps the sidebar aside below a 720px page.",
    "The scrim label is a verb: Close panel.",
    "Pass the app theme through the theme prop (appearance, sidebar, mainScreen); surfaces outside the shell (portals, first run) use adaptiveShellThemeClasses.",
    "frame=\"cards\" applies to the docked layout only; drawers (phones, tablets) stay full-bleed. Do not wrap AdaptiveShellSplit or a standalone BrowserPane in AdaptiveShellCard: they are cards already.",
    "A wallpaper inside a card resolves against the card and is clipped to its corners; the shell and the title row stay the window material.",
  ],
  accessibility: [
    "The scrim is a button only while open; drawers keep focus order sidebar → workspace → inspector.",
    "The split handle is a vertical separator with its value (340–560): arrows move 16px, Shift 48px, Home/End jump.",
  ],
  tokens: ["--adaptive-drawer-width", "--adaptive-inspector-width", "--adaptive-panel-duration", "--adaptive-scrim-bg", "--sidebar-width",
    "--browser-chat-width", "--browser-chat-width-min", "--browser-chat-width-max",
    "--shell-bg", "--shell-card-bg", "--shell-card-inset", "--shell-card-gap", "--shell-card-radius", "--shell-card-edge", "--shell-card-shadow",
    "--shell-sheet-tint", "--shell-page-shadow"],
};
