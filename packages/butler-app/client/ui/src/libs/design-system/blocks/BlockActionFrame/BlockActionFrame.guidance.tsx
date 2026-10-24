import type { ShowcaseGuidance } from "../../showcase";
import { Copy, Library } from "../../components/Icons";
import { MetricCard } from "../MetricCard";
import { BlockActionFrame } from "./BlockActionFrame";

const ACTIONS = [
  { label: "Save to library", icon: <Library size="sm" />, onSelect: () => undefined },
  { label: "Copy", icon: <Copy size="sm" />, onSelect: () => undefined },
];

// #region recipe: An answer block with actions
function AnswerBlock() {
  return (
    <BlockActionFrame actions={ACTIONS} actionsLabel="Block actions" title="This month">
      <MetricCard label="Spending" value="1.24M" />
    </BlockActionFrame>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One content block with its title and a ⋯ menu that shows on hover or focus; a right-click or a touch long-press opens the same menu, for the innermost block only. Pair with flySaveToTarget for the save flight.",
  whenToUse: ["Answer blocks, 서랍 block scraps and blocks in a document", "Container blocks and their children (level=\"child\" for the children)"],
  whenNotToUse: [
    { when: "A list row's actions", use: "ListRow" },
    { when: "A card's own menu", use: "OverflowActionMenu" },
  ],
  recipes: [{ name: "An answer block with actions", description: "The ⋯ sits at the title row's end; untitled blocks float it on the top end corner.", render: () => <AnswerBlock /> }],
  doDont: [
    {
      do: { caption: "One ⋯ per block, shown for the block under the pointer.", render: () => <AnswerBlock /> },
      dont: { caption: "Always-visible icon buttons on every block crowd the answer.", render: () => <MetricCard label="Spending" value="1.24M" icon={<Library size="sm" />} /> },
    },
  ],
  content: ["Actions are a few words: 서랍에 저장, 문서로 만들기, 복사.", "flySaveToTarget(block, target): a ghost of the block's box flies into the target over --motion-flight; reduced motion, or no visible target, crossfades."],
  accessibility: ["The ⋯ stays in the tab order while hidden and appears on keyboard focus.", "Touch screens keep the ⋯ invisible; a long-press (500 ms, without moving) opens the same menu and cancels any enclosing long-press menu."],
  tokens: ["--space-sm", "--space-xs", "--surface-raised", "--shadow-control", "--motion-fast", "--motion-flight"],
};
