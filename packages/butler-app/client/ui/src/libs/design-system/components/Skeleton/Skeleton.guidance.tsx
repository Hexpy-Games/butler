import type { ShowcaseGuidance } from "../../showcase";
import { Spinner } from "../Spinner";
import { Stack } from "../Stack";
import { Skeleton, SkeletonRows } from "./index";

// #region recipe: Loading list rows
function LoadingRows() {
  return (
    <Stack gap="sm" aria-busy="true">
      <Skeleton label="Loading settings" height="title" width="2/5" />
      <Skeleton height="row" width="full" />
      <Skeleton height="row" width="full" />
    </Stack>
  );
}
// #endregion

// #region recipe: Paragraph placeholder
function Paragraph() {
  return <Skeleton lines={3} height="line" label="Preparing the response" />;
}
// #endregion

// #region recipe: Placeholder rows for a list or form
function ListRows() {
  return <SkeletonRows rows={3} shape="list" label="Loading automations" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A shimmering placeholder in the shape of content that is still loading.",
  whenToUse: ["The layout of the coming content is known (rows, lines, cards)"],
  whenNotToUse: [
    { when: "Loading has no known shape or is inside a control", use: "Spinner" },
    { when: "Loading failed", use: "Notice" },
  ],
  recipes: [
    { name: "Loading list rows", description: "Give the first skeleton a label so the region is announced as loading.", render: () => <LoadingRows /> },
    { name: "Paragraph placeholder", description: "lines stacks text lines with a long, medium, short width ramp.", render: () => <Paragraph /> },
    { name: "Placeholder rows for a list or form", description: "SkeletonRows stacks list-height rows (or label + control for shape field) so a list never flashes its empty state first.", render: () => <ListRows /> },
  ],
  doDont: [
    {
      do: { caption: "Match the real row heights so nothing jumps when data arrives.", render: () => <LoadingRows /> },
      dont: { caption: "A spinner in the middle of a list hides the layout that is coming.", render: () => <Stack cross="center"><Spinner size={20} /></Stack> },
    },
  ],
  content: ["Size with width (full, 3/4, 2/3, 1/2, 2/5, 1/3, 1/4 or a number of characters), height (line, title, control, row) and shape; lines renders a paragraph.", "The label says what loads: Loading settings.", "Settings sections get SkeletonRows through SettingsSection state=\"loading\"; use SkeletonRows directly only outside settings."],
  accessibility: ["Unlabelled skeletons are aria-hidden; one labelled skeleton uses role=\"status\"."],
  tokens: ["--surface-raised", "--shimmer-duration", "--radius-control"],
};
