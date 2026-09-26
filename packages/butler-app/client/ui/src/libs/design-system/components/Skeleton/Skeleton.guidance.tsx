import type { ShowcaseGuidance } from "../../showcase";
import { Spinner } from "../Spinner";
import { Stack } from "../Stack";
import { Skeleton } from "./index";

// #region recipe: Loading list rows
function LoadingRows() {
  return (
    <Stack gap="sm" aria-busy="true">
      <Skeleton label="Loading settings" style={{ height: 18, width: "40%" }} />
      <Skeleton style={{ height: 44, width: "100%" }} />
      <Skeleton style={{ height: 44, width: "100%" }} />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A shimmering placeholder in the shape of content that is still loading.",
  whenToUse: ["The layout of the coming content is known (rows, lines, cards)"],
  whenNotToUse: [
    { when: "Loading has no known shape or is inside a control", use: "Spinner" },
    { when: "Loading failed", use: "Notice" },
  ],
  recipes: [{ name: "Loading list rows", description: "Give the first skeleton a label so the region is announced as loading.", render: () => <LoadingRows /> }],
  doDont: [
    {
      do: { caption: "Match the real row heights so nothing jumps when data arrives.", render: () => <LoadingRows /> },
      dont: { caption: "A spinner in the middle of a list hides the layout that is coming.", render: () => <Stack cross="center"><Spinner size={20} /></Stack> },
    },
  ],
  content: ["The label says what loads: Loading settings."],
  accessibility: ["Unlabelled skeletons are aria-hidden; one labelled skeleton uses role=\"status\"."],
  tokens: ["--surface-raised", "--shimmer-duration", "--radius-control"],
};
