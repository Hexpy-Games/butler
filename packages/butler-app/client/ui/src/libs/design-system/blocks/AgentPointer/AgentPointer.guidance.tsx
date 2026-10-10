import type { ShowcaseGuidance } from "../../showcase";
import { Typo } from "../../components/Typo";
import { AgentPointer } from "./AgentPointer";

// #region recipe: Clicking a product
function Clicking() {
  return (
    <div style={{ position: "relative", height: 160 }}>
      <AgentPointer mode="click" at={{ x: 150, y: 70 }} target={{ x: 90, y: 30, width: 120, height: 90 }} from={{ x: 20, y: 140 }} width={320} height={160} />
    </div>
  );
}
// #endregion

// #region recipe: Parked while you hold the tab
function Parked() {
  return (
    <div style={{ position: "relative", height: 120 }}>
      <AgentPointer mode="parked" tone="waiting" at={{ x: 220, y: 60 }} width={320} height={120} />
    </div>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Butler's own pointer for the transparent overlay layer above a page: where Butler looks, clicks, types or scrolls, never mistaken for yours.",
  whenToUse: ["The overlay renderer while Butler acts on a tab", "Showing that Butler waits (parked) while you hold the tab or an approval waits"],
  whenNotToUse: [
    { when: "Saying what Butler is doing in words", use: "PageBand" },
    { when: "A pick highlight the user made", use: "SelectionBar" },
  ],
  recipes: [
    { name: "Clicking a product", description: "Ring on the target, ripple at the point, a trail from the last point.", render: () => <Clicking /> },
    { name: "Parked while you hold the tab", description: "The arrow fades, the tag says why; nothing moves.", render: () => <Parked /> },
  ],
  doDont: [
    {
      do: { caption: "Geometry in layer pixels (page CSS pixels × page scale); the block draws, the renderer measures.", render: () => <Clicking /> },
      dont: { caption: "Draw it in the page DOM: the site can restyle, hide or read it.", render: () => <Typo.Code>{"page.evaluate(() => document.body.append(cursor))"}</Typo.Code> },
    },
    {
      do: { caption: "Pass each new `at` and `target` as it comes: the arrow glides on a curve (and retargets mid-glide without a jump), the click ripple starts on arrival; rings appear in place and fade.", render: () => <Clicking /> },
      dont: { caption: "Tween the pointer or a ring in the renderer, or send a whole-page rect expecting a ring: it draws none (the page edge shows it).", render: () => <Typo.Code>{"target={{ x: 0, y: 0, width: layer.width, height: layer.height }}"}</Typo.Code> },
    },
  ],
  content: ["Tag copy: Butler / 버틀러, Looking / 보는 중, Typing / 입력 중, Awaiting approval / 승인 기다리는 중.", "Masked values (passwords) are masked by the App before they reach `value`."],
  accessibility: [
    "Decorative (aria-hidden): the PageBand announces what Butler does.",
    "Reduced motion (OS, the DS scope or `reducedMotion`): no glide, trail, ripple or ring fade; the pointer jumps and rings appear at once.",
    "Outline: a dark halo under a white keyline reaches 3:1 on white, black and photo pages (tested).",
  ],
  tokens: ["--motion-pointer-glide", "--motion-ease-standard", "--motion-fast", "--motion-exit-fast", "--butler-ink-blue", "--butler-ink-purple", "--butler-ink-pink", "--browser-overlay-shadow"],
};
