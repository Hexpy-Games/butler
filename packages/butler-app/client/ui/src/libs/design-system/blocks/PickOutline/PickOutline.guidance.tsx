import type { ReactNode } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { testPage } from "../BrowserPane/fixtures/pages";
import { PickOutline } from "./PickOutline";

const CARD = { x: 24, y: 40, width: 120, height: 150 };
const NEXT = { x: 168, y: 40, width: 120, height: 150 };

function Stage({ children }: { children: ReactNode }) {
  return <div style={{ position: "relative", width: 320, height: 210, backgroundImage: `url("${testPage("white")}")`, borderRadius: "var(--radius-control)" }}>{children}</div>;
}

// #region recipe: Picking on a page
function Picking() {
  return (
    <Stage>
      <PickOutline width={320} height={210} picks={[{ id: "a", rect: CARD }]} hover={NEXT} hoverLabel="div.card · 120 × 150" />
    </Stage>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The user's pick marks in the overlay layer above a page: a dashed outline with a size tag on the element under the pointer, and solid outlines numbered in pick order.",
  whenToUse: ["Pick mode in the browser overlay renderer (hover and picks)", "A kept selection after pick mode ends (picks only)"],
  whenNotToUse: [
    { when: "Butler acting on the page (its pointer and target ring)", use: "AgentPointer" },
    { when: "The count and actions for the picks", use: "SelectionBar" },
  ],
  recipes: [{ name: "Picking on a page", description: "Rects in layer pixels (page CSS pixels times the page scale); badges number the picks in order.", render: () => <Picking /> }],
  doDont: [
    {
      do: { caption: "Draw the marks in the overlay layer, from the rects the renderer measures.", render: () => <Picking /> },
      dont: { caption: "Do not show picks as hover outlines: dashed means under the pointer; picked is solid, tinted and numbered.", render: () => <Stage><PickOutline width={320} height={210} hover={CARD} /></Stage> },
    },
  ],
  content: ["Hover tag: the element's short name and its size in CSS pixels (div.card · 158 × 236); no sentences.", "Badges: the pick order (1, 2, …, 99+)."],
  accessibility: ["Decorative (aria-hidden); SelectionBar names the count and the actions.", "Reduced motion (OS, DS scope or `reducedMotion`): no fade or pop."],
  tokens: ["--browser-pick-ink", "--browser-pick-keyline", "--browser-pick-tint", "--browser-overlay-shadow"],
};
