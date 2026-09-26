import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { Inline } from "../Inline";
import { Tag } from "./Tag";

// #region recipe: Status and removable filters
function StatusTags() {
  return (
    <Inline gap="xs">
      <Tag tone="success">active</Tag>
      <Tag tone="warning">paused</Tag>
      <Tag onRemove={() => undefined} removeLabel="Remove filter: design">design</Tag>
    </Inline>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A small pill for a status, category or removable filter value.",
  whenToUse: ["Show a status or category next to a title", "A removable filter chip"],
  whenNotToUse: [
    { when: "A clickable action", use: "PillButton" },
    { when: "An inline error or result message", use: "Notice" },
  ],
  recipes: [{ name: "Status and removable filters", description: "Tones map to semantic colors; onRemove adds a labelled remove button.", render: () => <StatusTags /> }],
  doDont: [
    {
      do: { caption: "Tags label; they do not act.", render: () => <StatusTags /> },
      dont: { caption: "A button styled as a tag hides that it acts.", render: () => <Button size="xs" variant="outline" shape="pill" text="active" /> },
    },
  ],
  content: ["One or two lowercase words in English; Korean uses the noun form (활성)."],
  accessibility: ["Color is never the only signal: the word says the state; removeLabel names the remove button."],
  tokens: ["--radius-pill", "--color-success-bg", "--color-warning-bg", "--color-danger-bg", "--line"],
};
