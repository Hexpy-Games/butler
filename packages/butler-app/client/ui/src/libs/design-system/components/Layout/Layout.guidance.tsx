import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../Stack";
import { Tag } from "../Tag";
import { Typo } from "../Typo";

// #region recipe: Grow, basis and truncation
function UsageRow() {
  return (
    <Stack align="row" gap="md" wrap>
      <Stack.Item grow basis="md" minWidth="0">
        <Typo.Body truncate>Provider usage and remaining quota for this month</Typo.Body>
      </Stack.Item>
      <Stack.Item shrink={false}><Tag>12,480</Tag></Stack.Item>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Layout item props (grow, shrink, basis, minWidth, alignSelf, span, invisible) that place children of Stack and Grid.",
  whenToUse: ["Let one child take the free space", "Keep a trailing item from shrinking", "Reserve space for a hidden item"],
  whenNotToUse: [
    { when: "Padding or a surface", use: "Box" },
    { when: "Spacing between siblings", use: "Stack" },
  ],
  recipes: [{ name: "Grow, basis and truncation", description: "basis uses the --layout-basis-* scale; minWidth=\"0\" enables truncation.", render: () => <UsageRow /> }],
  doDont: [
    {
      do: { caption: "Item props on Stack.Item or directly on Stack.", render: () => <UsageRow /> },
      dont: { caption: "flex styles on a wrapper div bypass the tokens.", render: () => <div style={{ display: "flex" }}><div style={{ flex: "1 1 260px" }}><Typo.Body>Usage</Typo.Body></div></div> },
    },
  ],
  content: ["No copy of its own."],
  accessibility: ["invisible keeps the space but removes the item from the tab order and the accessibility tree."],
  tokens: ["--layout-basis-xs", "--layout-basis-sm", "--layout-basis-md", "--layout-basis-lg"],
};
