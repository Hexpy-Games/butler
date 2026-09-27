import type { ShowcaseGuidance } from "../../showcase";
import { Clock3 } from "../Icons";
import { Stack } from "../Stack";
import { Tag } from "../Tag";
import { Typo } from "../Typo";
import { Inline } from "./Inline";

// #region recipe: Metadata line
function MetadataLine() {
  return (
    <Inline gap="xs">
      <Clock3 size="sm" />
      <Typo.Caption tone="secondary">Every day 07:00</Typo.Caption>
      <Tag tone="success">active</Tag>
    </Inline>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A wrapping row for chips, tags and icon-plus-text metadata, centered on one line.",
  whenToUse: ["A row of tags or chips that may wrap", "An icon next to a caption"],
  whenNotToUse: [
    { when: "Rows that should not wrap, or need grow/truncate", use: "Stack" },
    { when: "Adjacent buttons", use: "ButtonContainer" },
  ],
  recipes: [{ name: "Metadata line", description: "Inline wraps by default and centers items on the cross axis.", render: () => <MetadataLine /> }],
  doDont: [
    {
      do: { caption: "Chips wrap naturally at narrow widths.", render: () => <Inline><Tag>design</Tag><Tag>motion</Tag><Tag>tokens</Tag></Inline> },
      dont: { caption: "A non-wrapping row of chips overflows on phones.", render: () => <Stack align="row" gap="sm"><Tag>design</Tag><Tag>motion</Tag><Tag>tokens</Tag></Stack> },
    },
  ],
  content: ["Keep each item short; long items belong in a list."],
  accessibility: ["Decorative icons are aria-hidden; the text carries the meaning."],
  tokens: ["--space-sm", "--space-xs"],
};
