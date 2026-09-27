import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { RollingSwap } from "./RollingSwap";

const STEPS = ["Reading files", "Running tests", "Writing the answer"];

// #region recipe: Step label that rolls
function StepLabel() {
  const [index, setIndex] = useState(0);
  return (
    <Stack gap="sm">
      <RollingSwap itemKey={String(index)}><Typo.Body as="p">{STEPS[index]}</Typo.Body></RollingSwap>
      <Button size="sm" variant="outline" text="Next step" onClick={() => setIndex((index + 1) % STEPS.length)} />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Rolls one short piece of content out and the next one in when its key changes.",
  whenToUse: ["A status or step label that changes while work runs"],
  whenNotToUse: [
    { when: "Counting numbers", use: "AnimatedNumber" },
    { when: "Showing and hiding content", use: "Presence" },
  ],
  recipes: [{ name: "Step label that rolls", description: "Change itemKey to roll; the same key keeps the content still.", render: () => <StepLabel /> }],
  doDont: [
    {
      do: { caption: "Short labels that replace each other.", render: () => <StepLabel /> },
      dont: { caption: "Rolling long paragraphs is hard to read.", render: () => <Typo.Body>Whole paragraphs swapped every second</Typo.Body> },
    },
  ],
  content: ["Two to five words per step."],
  accessibility: ["Pair with a live region when the change matters to screen reader users."],
  tokens: ["--motion-base", "--motion-distance-sm", "--motion-ease-decelerate"],
};
