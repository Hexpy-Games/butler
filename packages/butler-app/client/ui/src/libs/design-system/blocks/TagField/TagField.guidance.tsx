import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Input } from "../../components/Input";
import { TagField } from "./TagField";

// #region recipe: Tags on a saved item
function ItemTags() {
  const [tags, setTags] = useState(["jeju", "stays"]);
  return (
    <TagField value={tags} onChange={setTags} label="Tags" placeholder="Add tag" removeLabel={(n) => `Remove ${n}`}
      createLabel={(n) => `Create tag “${n}”`} suggestions={[{ name: "cafés", count: 14 }, { name: "camping", count: 3 }]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Tags as removable chips inside one field, completing from existing tags as you type, with a row that creates a new tag.",
  whenToUse: ["Tags on a saved Library item (card popover, detail panel)", "Any short list of free labels with completion"],
  whenNotToUse: [
    { when: "One value from a fixed list", use: "Select" },
    { when: "Filtering a list by tags", use: "FilteredSelectPopover" },
  ],
  recipes: [{ name: "Tags on a saved item", description: "Pass the item's tags and every existing tag with its count.", render: () => <ItemTags /> }],
  doDont: [
    {
      do: { caption: "Chips plus completion from tags that already exist.", render: () => <ItemTags /> },
      dont: { caption: "Do not ask for comma-separated text.", render: () => <Input aria-label="Tags" defaultValue="jeju, stays" /> },
    },
  ],
  content: ["Placeholder: “Add tag” / “태그 추가”. Create row: “Create tag “ca”” / “‘카’ 태그 만들기”. Tags are short words, 40 characters at most."],
  accessibility: [
    "The input is a combobox with a listbox of completions; arrows move, Enter or a comma adds, Backspace on an empty field removes the last chip.",
    "Each chip's remove button is named by removeLabel.",
  ],
  tokens: ["--menu-item-height", "--focus-ring", "--selection", "--tag-height-sm"],
};
