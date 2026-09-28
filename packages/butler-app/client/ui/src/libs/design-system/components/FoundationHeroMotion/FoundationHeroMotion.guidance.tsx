import type { ShowcaseGuidance } from "../../showcase";
import { FoundationHeroMotion } from "./FoundationHeroMotion";

// #region recipe: Chapter header hero
function ChapterHero() {
  return <FoundationHeroMotion variant="motion" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The looping motion graphic at the head of a Foundations chapter, drawn from that foundation's live tokens.",
  whenToUse: ["The header of a Foundations chapter in the DS Viewer (one hero per chapter)"],
  whenNotToUse: [
    { when: "Showing that something is loading or working", use: "Spinner" },
    { when: "Butler itself is thinking", use: "ButlerThinkingMark" },
    { when: "A small chapter thumbnail in a card grid", use: "Card" },
  ],
  recipes: [{ name: "Chapter header hero", description: "Pass the chapter id as the variant; the stage fills its column at 8:5.", render: () => <ChapterHero /> }],
  doDont: [
    {
      do: { caption: "One hero per chapter header, beside or under the title.", render: () => <FoundationHeroMotion variant="spacing" /> },
      dont: { caption: "Several heroes in one view compete; show the still poster instead.", render: () => <FoundationHeroMotion variant="spacing" still /> },
    },
  ],
  content: ["No text inside the graphic except the type specimen (Aa가); the chapter title and lead carry the meaning."],
  accessibility: [
    "Decorative: aria-hidden, no focus stop.",
    "Reduced motion (OS setting or the DS data-motion=\"reduced\" scope) shows a still poster with no animation.",
    "Pauses offscreen and in a hidden tab.",
  ],
  tokens: [
    "--motion-deliberate", "--motion-ease-standard", "--motion-ease-emphasized", "--motion-ease-spring", "--motion-distance-md",
    "--space-xs", "--space-4xl", "--control-height-xs", "--control-height-lg", "--icon-size-xs", "--icon-size-2xl",
    "--radius-control", "--radius-composer", "--shadow-card", "--shadow-window", "--focus-ring",
  ],
};
