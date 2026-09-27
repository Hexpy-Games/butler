import type { ShowcaseGuidance } from "../../showcase";
import { Typo } from "../../components/Typo";
import { ChangedLineDiff } from "./ChangedLineDiff";

// #region recipe: Changed lines of one file
function ChangedLines() {
  return (
    <ChangedLineDiff ariaLabel="Changed lines in motion.ts" id="motion-diff" lines={[
      { type: "deleted", old_line: 12, content: "const duration = 160;" },
      { type: "added", new_line: 12, content: "const duration = motionDuration(\"base\");" },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Added and deleted lines of one changed file with line numbers, inside a changed-file row.",
  whenToUse: ["Show what changed in a file under an assistant answer"],
  whenNotToUse: [
    { when: "Showing a whole file or snippet", use: "MarkdownCodeFrame" },
    { when: "Listing files without line detail", use: "ListRow" },
  ],
  recipes: [{ name: "Changed lines of one file", description: "Put it inside a plain DisclosureRow titled with the path.", render: () => <ChangedLines /> }],
  doDont: [
    {
      do: { caption: "Line numbers and +/− marks for each change.", render: () => <ChangedLines /> },
      dont: { caption: "A prose summary of a diff hides the exact change.", render: () => <Typo.Body>Changed the duration to use a token.</Typo.Body> },
    },
  ],
  content: ["The aria-label names the file: Changed lines in <path>."],
  accessibility: ["Additions and deletions are marked with text symbols, not color only."],
  tokens: ["--syntax-addition", "--syntax-deletion", "--typo-code-size", "--font-family-code"],
};
