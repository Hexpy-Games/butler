import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { MarkdownCodeFrame, MarkdownContent, MarkdownTable } from "./index";

// #region recipe: Document with code and a table
function SpecExcerpt() {
  return (
    <MarkdownContent>
      <h2>Verification</h2>
      <p>Run the checks before shipping.</p>
      <MarkdownCodeFrame language="sh"><code>bun run lint:design</code></MarkdownCodeFrame>
      <MarkdownTable>
        <thead><tr><th>Check</th><th>Result</th></tr></thead>
        <tbody><tr><td>Types</td><td>Passed</td></tr></tbody>
      </MarkdownTable>
    </MarkdownContent>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Document typography for rendered markdown: headings, lists, code frames, tables, quotes and the streaming fade.",
  whenToUse: ["Assistant answers, READMEs and project documents rendered from markdown"],
  whenNotToUse: [
    { when: "UI text", use: "Typo" },
    { when: "Raw file contents", use: "ArtifactPreviewPre" },
  ],
  recipes: [{ name: "Document with code and a table", description: "Wrap markdown output; MarkdownCodeFrame and MarkdownTable replace pre and table.", render: () => <SpecExcerpt /> }],
  doDont: [
    {
      do: { caption: "Markdown rhythm comes from MarkdownContent.", render: () => <SpecExcerpt /> },
      dont: { caption: "Typo stacks for a document lose list and code styling.", render: () => <Stack gap="xs"><Typo.H2>Verification</Typo.H2><Typo.Body>- Run the checks</Typo.Body></Stack> },
    },
  ],
  content: ["Headings in sentence case; code blocks name their language."],
  accessibility: ["Real headings, lists and tables; streaming spans never move text (no layout shift)."],
  tokens: ["--line-height-document", "--typo-code-size", "--syntax-keyword", "--radius-panel"],
};
