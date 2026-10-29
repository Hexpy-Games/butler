import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { NativeSelect, NativeSelectOption } from "../../components/NativeSelect";
import { VersionHistory } from "./VersionHistory";

const ENTRIES = [
  { id: "3", author: "butler" as const, authorLabel: "Butler", time: "3:12 PM" },
  { id: "2", author: "user" as const, authorLabel: "Me", time: "3:05 PM" },
  { id: "1", author: "butler" as const, authorLabel: "Butler", time: "Yesterday" },
];

// #region recipe: Preview and restore
function PreviewAndRestore() {
  const [selected, setSelected] = useState("2");
  return <VersionHistory entries={ENTRIES} selectedId={selected} onSelect={setSelected} label="Versions" currentLabel="Current"
    action={selected === "3" ? undefined : <Button size="sm" variant="secondary">Restore</Button>} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A document's versions, newest first: who made each (나 or 버틀러) and when; pick one to preview, restore it from the footer.",
  whenToUse: ["The 버전 기록 of an editable document, inside a Popover (a screen-wide sheet on phones)"],
  whenNotToUse: [
    { when: "File revisions of a read-only deliverable", use: "NativeSelect" },
    { when: "Browsing history", use: "HistoryRow" },
  ],
  recipes: [{ name: "Preview and restore", description: "Restore shows only for an older version.", render: () => <PreviewAndRestore /> }],
  doDont: [
    {
      do: { caption: "Who and when on every version; restore from the footer.", render: () => <PreviewAndRestore /> },
      dont: { caption: "A bare number list hides who changed the document.", render: () => <NativeSelect aria-label="Version"><NativeSelectOption value="3">3</NativeSelectOption><NativeSelectOption value="2">2</NativeSelectOption></NativeSelect> },
    },
  ],
  content: ["Author labels are 나 and 버틀러; the newest row says 현재.", "Restore is one word (되돌리기) and appears only for an older version."],
  accessibility: ["A listbox of options; the previewed version is aria-selected.", "Times use a time element with a machine-readable dateTime."],
  tokens: ["--selection", "--butler-ink-blue", "--butler-ink-purple", "--butler-ink-pink", "--radius-control"],
};
