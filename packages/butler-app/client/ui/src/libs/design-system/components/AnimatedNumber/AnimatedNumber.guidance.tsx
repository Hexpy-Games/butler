import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { MetricCard } from "../../blocks/MetricCard";
import { Button } from "../Button";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { AnimatedNumber } from "./AnimatedNumber";

// #region recipe: Count in running text
function QueuedCount() {
  const [count, setCount] = useState(3);
  return (
    <Stack gap="sm">
      <Typo.Body><AnimatedNumber value={count} live /> messages are queued.</Typo.Body>
      <Button size="sm" variant="outline" text="Queue another" onClick={() => setCount(count + 1)} />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Counts from the shown value to a new one over --motion-deliberate with tabular digits.",
  whenToUse: ["A number that changes while people watch (counts, totals)"],
  whenNotToUse: [
    { when: "A metric tile", use: "MetricCard" },
    { when: "A static number", use: "Typo.Text" },
  ],
  recipes: [{ name: "Count in running text", description: "live announces the final value; the counting text is hidden from screen readers.", render: () => <QueuedCount /> }],
  doDont: [
    {
      do: { caption: "MetricCard already counts numeric values.", render: () => <MetricCard label="Open work" value={12} /> },
      dont: { caption: "Animating a number that did not change draws attention for nothing.", render: () => <Typo.Body>Counting up on every render</Typo.Body> },
    },
  ],
  content: ["Format with the app locale (default Intl.NumberFormat) or pass format for units."],
  accessibility: ["Screen readers read the final formatted value from visually hidden text."],
  tokens: ["--motion-deliberate", "--motion-ease-decelerate", "--motion-fast"],
};
