import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { Card } from "../Card";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Presence } from "./Presence";

// #region recipe: Hint that rises in and fades out
function DismissibleHint() {
  const [present, setPresent] = useState(true);
  return (
    <Stack gap="md">
      <Button variant="outline" text={present ? "Hide hint" : "Show hint"} onClick={() => setPresent(!present)} />
      <Presence present={present} motion="rise">
        <div><Card><Typo.Body>Drag a conversation onto a folder to group it.</Typo.Body></Card></div>
      </Presence>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Keeps a child mounted through its exit animation and exposes data-state open/closed.",
  whenToUse: ["Mount and unmount a small element with a fade or rise", "Build a DS component that needs an exit animation"],
  whenNotToUse: [
    { when: "Revealing content with a height change", use: "Collapsible" },
    { when: "Swapping one line of status text", use: "RollingSwap" },
  ],
  recipes: [{ name: "Hint that rises in and fades out", description: "The child must forward its ref and accept data-state.", render: () => <DismissibleHint /> }],
  doDont: [
    {
      do: { caption: "Presence runs the exit before unmounting.", render: () => <DismissibleHint /> },
      dont: { caption: "A conditional render cuts the element off mid-frame.", render: () => <Typo.Body>{"{present && <Hint />}"}</Typo.Body> },
    },
  ],
  content: ["No copy of its own."],
  accessibility: ["Exited content is unmounted, so it leaves the accessibility tree once the exit ends."],
  tokens: ["--motion-base", "--motion-exit-base", "--motion-distance-sm"],
};
