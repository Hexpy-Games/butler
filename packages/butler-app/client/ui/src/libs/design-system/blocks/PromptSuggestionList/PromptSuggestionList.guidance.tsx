import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { PROMPT_FLUID_PALETTES, PromptFluidBackground, PromptFluidPaletteControl, PromptSuggestionList } from "./index";

// #region recipe: New chat suggestions
function NewChatSuggestions() {
  return (
    <PromptSuggestionList title="Where should we start today?" description="Pick a next step or type your own." suggestions={[
      { id: "review", title: "Review risky changes", description: "Find missed checks in recent work.", text: "Review the risky parts of recent changes" },
      { id: "plan", title: "Plan today", description: "Order open work into steps.", text: "Plan today's work in order" },
    ]} />
  );
}
// #endregion

// #region recipe: Fluid background with a palette picker
function FluidPicker() {
  const options = Object.entries(PROMPT_FLUID_PALETTES).slice(0, 3).map(([id, colors]) => ({ id, colors, label: id }));
  const [selected, setSelected] = useState(options[0]?.id);
  return (
    <Stack gap="sm">
      <div style={{ position: "relative", height: 120, contain: "layout paint" }}>
        <PromptFluidBackground palette={options.find((option) => option.id === selected)?.colors} />
      </div>
      <PromptFluidPaletteControl options={options} selectedId={selected} onSelect={setSelected} />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The new-chat starter: a headline, prompt suggestions that fill the composer, and the optional fluid background.",
  whenToUse: ["An empty conversation that should offer next steps"],
  whenNotToUse: [
    { when: "Nothing to suggest", use: "EmptyLine" },
    { when: "A decorative translucent surface", use: "TintedGlass" },
  ],
  recipes: [
    { name: "New chat suggestions", description: "Each suggestion carries the prompt text that goes into the composer.", render: () => <NewChatSuggestions /> },
    { name: "Fluid background with a palette picker", description: "PromptFluidBackground is a contained canvas; the palette control swaps its colors.", render: () => <FluidPicker /> },
  ],
  doDont: [
    {
      do: { caption: "Two to four concrete suggestions with a one-line description.", render: () => <NewChatSuggestions /> },
      dont: { caption: "Generic cards (Ask anything) that say nothing specific.", render: () => <Card><Typo.Body>Ask anything</Typo.Body></Card> },
    },
  ],
  content: ["Titles are actions (Plan today); the prompt text is what the user would type, in their language."],
  accessibility: ["Suggestions are buttons; the fluid background is decorative and stops under reduced motion."],
  tokens: ["--typo-new-chat-title-size", "--typo-new-chat-title-size-md", "--radius-panel", "--motion-base"],
};
