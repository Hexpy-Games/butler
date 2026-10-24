import type { ShowcaseGuidance } from "../../showcase";

export const guidance: ShowcaseGuidance = {
  purpose: "A document's versions, newest first: who made each (나 or 버틀러) and when; pick one to preview, restore it from the footer.",
  whenToUse: ["The 버전 기록 of an editable document, inside a Popover (a screen-wide sheet on phones)"],
  whenNotToUse: [
    { when: "File revisions of a read-only deliverable", use: "the artifact viewer's version select" },
    { when: "Browsing history", use: "HistoryRow" },
  ],
  recipes: [],
  doDont: [],
  content: ["Author labels are 나 and 버틀러; the newest row says 현재.", "Restore is one word (되돌리기) and appears only for an older version."],
  accessibility: ["A listbox of options; the previewed version is aria-selected.", "Times use a time element with a machine-readable dateTime."],
  tokens: ["--selection", "--butler-ink-blue", "--butler-ink-purple", "--butler-ink-pink", "--radius-control"],
};
