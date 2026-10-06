import type { ShowcaseGuidance } from "../../showcase";
import { ArtifactPreviewImage } from "../ArtifactPreview";
import { PAGE_SRC, SlotDemo } from "./NativeViewSlot.demo";
import { NativeViewSlot } from "./NativeViewSlot";
import type { NativeViewBounds } from "./nativeViewGeometry";

/** Stand-in for the App bridge (the preload exposes main-process calls). */
const bridge: { setBounds: (bounds: NativeViewBounds) => void; setCovered: (covered: boolean) => void } = {
  setBounds: () => undefined,
  setCovered: () => undefined,
};

// #region recipe: Browser page area
function BrowserPage({ still }: { still?: string }) {
  // The container forwards bounds and occlusion to Electron main, which places the WebContentsView
  // and, while covered, hides it after capturing the still it passes back as stillSrc.
  return <NativeViewSlot id="browser-page" role="tabpanel" stillSrc={still} onBoundsChange={bridge.setBounds} onOcclusion={bridge.setCovered} />;
}
// #endregion

// #region recipe: Agent tab at a fixed viewport
function AgentPage() {
  // bounds.scale is the zoom factor that shows the 1280×800 page in the slot's width.
  return <NativeViewSlot viewport={{ width: 1280, height: 800 }} onBoundsChange={bridge.setBounds} onOcclusion={bridge.setCovered} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Reserves the rectangle a native Electron WebContentsView is laid over, reports its bounds and tells the App when DS overlays or moving panels cover it.",
  whenToUse: [
    "Placing a native browser view (WebContentsView) inside App layout",
    "Showing an agent's fixed-size page scaled to the available width",
  ],
  whenNotToUse: [
    { when: "Showing a captured page or artifact image", use: "ArtifactPreview" },
    { when: "Rendering web content inside the DOM", use: "DocumentReader" },
  ],
  recipes: [
    { name: "Browser page area", description: "The slot is the tab panel; the container bridges callbacks to the main process.", render: () => <BrowserPage /> },
    { name: "Agent tab at a fixed viewport", description: "The frame keeps the 16:10 aspect; zoom the page by bounds.scale.", render: () => <AgentPage /> },
  ],
  doDont: [
    {
      do: { caption: "Let the slot report bounds and occlusion; it swaps in the still while covered.", render: () => <SlotDemo locale="en-US" covered height="8rem" /> },
      dont: { caption: "Do not show a static screenshot as the live page; it never updates or takes input.", render: () => <ArtifactPreviewImage src={PAGE_SRC} alt="" /> },
    },
  ],
  content: [
    "The slot has no copy of its own. Empty and crashed states go in children (EmptyLine, Notice).",
    "Pass stillAlt only when the still carries meaning beyond the page it stands in for.",
  ],
  accessibility: [
    "Give the slot id and role=tabpanel and pass that id to TabStrip panelId so tabs control it.",
    "The native view has its own accessibility tree; the slot only frames it.",
    "Reduced motion: the slot adds no motion; panel motion it reacts to is the shell's.",
  ],
  tokens: ["--z-popover", "--z-tooltip", "--z-dialog", "--adaptive-panel-duration"],
};
