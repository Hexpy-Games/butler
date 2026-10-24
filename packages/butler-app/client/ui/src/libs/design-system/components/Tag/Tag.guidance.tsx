import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { DropdownMenuItem } from "../DropdownMenu";
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

// #region recipe: Category labels
function CategoryLabels() {
  return (
    <Inline gap="xs">
      <Tag tone="red">bug</Tag>
      <Tag tone="teal">design</Tag>
      <Tag tone="purple">research</Tag>
    </Inline>
  );
}
// #endregion

// #region recipe: Editable label
function EditableLabel() {
  return (
    <Tag tone="teal" onRemove={() => undefined} removeLabel="Remove design" editLabel="design tag menu" editMenu={<>
      <DropdownMenuItem>Rename</DropdownMenuItem>
      <DropdownMenuItem>Change color</DropdownMenuItem>
      <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
    </>}>design</Tag>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A small pill for a status, category or removable filter value.",
  whenToUse: ["Show a status or category next to a title", "A removable filter chip", "A user's own category label in a color they chose (label tones)"],
  whenNotToUse: [
    { when: "A clickable action", use: "PillButton" },
    { when: "An inline error or result message", use: "Notice" },
    { when: "Picking a label tone", use: "TagColorSwatches" },
  ],
  recipes: [
    { name: "Status and removable filters", description: "Tones map to semantic colors; onRemove adds a labelled remove button.", render: () => <StatusTags /> },
    { name: "Category labels", description: "Label tones (gray, red, orange, yellow, green, teal, blue, purple) name a category, not a status.", render: () => <CategoryLabels /> },
    { name: "Editable label", description: "editMenu adds a pencil before remove that opens the label's own menu (rename, recolor, delete). Only where the label is editable.", render: () => <EditableLabel /> },
  ],
  doDont: [
    {
      do: { caption: "Tags label; they do not act.", render: () => <StatusTags /> },
      dont: { caption: "A button styled as a tag hides that it acts.", render: () => <Button size="xs" variant="outline" shape="pill" text="active" /> },
    },
  ],
  content: ["size=\"sm\" (default) for inline chips; size=\"md\" for page eyebrows and hero labels.",
    "Status tones (neutral, accent, success, warning, danger) mean a state; label tones (gray … purple) only tell categories apart. Never use a label tone for a status.",
    "Store a label tone by its name (\"teal\"), never a color value: themes and wallpapers restyle it.",
    "editMenu: only where the label itself is editable (an edit form); cards and read-only views show the plain Tag. The pencil comes before remove.",
    "iconEnd: a trailing chevron when the Tag is the count cue inside a larger control that opens more (\"+4 ›\").", "One or two lowercase words in English; Korean uses the noun form (활성)."],
  accessibility: ["Color is never the only signal: the word says the state; removeLabel names the remove button; editLabel names the edit button.",
    "Label tones fill opaquely, so their text keeps 4.5:1 on light, dark, glass and wallpaper surfaces.",
    "A Tag with iconEnd is decoration inside its control; the control's own label carries the count."],
  tokens: ["--radius-pill", "--tag-height-sm", "--tag-padding-inline-sm", "--tag-padding-inline-md", "--icon-size-xs", "--color-success-bg", "--color-warning-bg", "--color-danger-bg", "--line", "--tag-label-blue-bg", "--tag-label-blue-fg", "--tag-label-blue-border"],
};
