import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { AspectFrame } from "./AspectFrame";

// #region recipe: Animated mark
function AnimatedMark() {
  return (
    <AspectFrame size="sm" aria-hidden="true">
      <canvas />
    </AspectFrame>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A square, paint-contained frame that sizes a canvas or media element.",
  whenToUse: ["A canvas animation or media that must stay square (the thinking mark)"],
  whenNotToUse: [
    { when: "An icon glyph", use: "IconSlot" },
    { when: "A document or image preview", use: "ArtifactPreview" },
  ],
  recipes: [{ name: "Animated mark", description: "size picks an icon token; omit it to fill the container width.", render: () => <AnimatedMark /> }],
  doDont: [
    {
      do: { caption: "The frame owns the square and the containment.", render: () => <AnimatedMark /> },
      dont: { caption: "A canvas without a frame stretches with its container.", render: () => <Stack><canvas height={8} /></Stack> },
    },
  ],
  content: ["Decorative frames are aria-hidden; describe meaningful media next to it."],
  accessibility: ["Pass aria-hidden for decorative marks."],
  tokens: ["--icon-size-sm", "--icon-size-2xl"],
};
