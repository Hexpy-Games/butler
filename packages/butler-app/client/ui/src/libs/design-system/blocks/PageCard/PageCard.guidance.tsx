import type { ShowcaseGuidance } from "../../showcase";
import { Typo } from "../../components/Typo";
import { PageBand } from "../PageBand";
import { PageCard } from "./PageCard";

// #region recipe: Butler's tab
function ButlerTab() {
  return (
    <div style={{ height: 240, display: "flex" }}>
      <PageCard holder="butler" viewport={{ width: 1280, height: 800 }} onBoundsChange={() => undefined}
        band={<PageBand tone="agent" label="Butler is browsing" detail="Click ‘Mesh Office Chair M2’" />} />
    </div>
  );
}
// #endregion

// #region recipe: Your tab, loading
function UserTab() {
  return (
    <div style={{ height: 200, display: "flex" }}>
      <PageCard loading={42} loadingLabel="Loading page" onBoundsChange={() => undefined} />
    </div>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The web page as one elevated card that wraps NativeViewSlot: who holds the tab, the band, the load line and Butler's letterboxed page.",
  whenToUse: [
    "The page area of BrowserPane (one card per visible tab)",
    "Showing who holds a tab: nobody, Butler (riso edge), you, or an approval",
  ],
  whenNotToUse: [
    { when: "A native view without the browser card (a raw slot)", use: "NativeViewSlot" },
    { when: "A static picture of a page in the chat", use: "ArtifactPreview" },
  ],
  recipes: [
    { name: "Butler's tab", description: "Fixed 1280×800 page, riso edge, the agent band.", render: () => <ButlerTab /> },
    { name: "Your tab, loading", description: "The page at the card's size with the 2px load line.", render: () => <UserTab /> },
  ],
  doDont: [
    {
      do: { caption: "Pass onBoundsChange through: bounds equal the content area and carry the corner radius for the native view.", render: () => <UserTab /> },
      dont: { caption: "Draw the holder edge in product CSS or resize the card per holder: the native view would move.", render: () => <Typo.Code>{".card { border: 2px solid purple }"}</Typo.Code> },
    },
  ],
  content: ["The scale note is numbers only (1280 × 800 · 55%).", "Empty and crashed states go in children with EmptyLine copy from browser.*."],
  accessibility: [
    "The content area is the tab panel (panelId); the band is the live region for holder changes.",
    "The riso edge turns on --motion-agent-edge and stops under reduced motion (a static edge).",
  ],
  tokens: ["--radius-popover", "--browser-card-shadow", "--butler-ink-blue", "--butler-ink-purple", "--butler-ink-pink", "--motion-agent-edge", "--motion-loop-count"],
};
