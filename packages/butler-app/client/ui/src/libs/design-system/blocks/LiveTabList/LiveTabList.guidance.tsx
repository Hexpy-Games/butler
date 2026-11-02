import type { ShowcaseGuidance } from "../../showcase";
import { LiveTabList } from "./LiveTabList";

// #region recipe: Capped live previews
function PreviewList() {
  return <LiveTabList tabs={[{ id: "map", title: "Riverside site map", onOpen: () => undefined }]}
    expanded={false} onExpandedChange={() => undefined}
    labels={{ more: n => `Show ${n} more tabs`, overflow: n => `+${n}`, less: "Show less" }} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Full live tab previews with a capped list and one measured favicon overflow row.",
  whenToUse: ["A compact list of live browser previews that can expand in place"],
  whenNotToUse: [{ when: "A navigable browser tab strip", use: "TabStrip" }, { when: "One tab preview", use: "LiveTabCard" }],
  recipes: [{ name: "Capped live previews", description: "The container supplies tabs, labels and expansion state.", render: () => <PreviewList /> }],
  doDont: [{ do: { caption: "Keep the full title and actions on each visible card.", render: () => <PreviewList /> },
    dont: { caption: "Use the overflow toggle instead of stacking every preview in a narrow panel.", render: () => <PreviewList /> } }],
  content: ["Default limit: three full cards. Localize more, less and the overflow count in the container.", "Examples support Korean and English."],
  accessibility: ["One Clickable toggle supports Tab, Enter and Space and exposes aria-expanded.", "The keyed toggle stays mounted across expansion to retain focus.", "Decorative favicons never wrap or clip; the count reserves its measured width.", "Do not clip the list or toggle; retain focus ring room in the containing panel."],
  tokens: ["--space-xs", "--focus-ring-room"],
};
