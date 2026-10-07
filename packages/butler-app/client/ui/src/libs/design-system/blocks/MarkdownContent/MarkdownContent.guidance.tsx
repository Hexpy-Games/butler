import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { MarkdownCodeFrame, MarkdownContent, MarkdownLink, MarkdownTable } from "./index";
import { sampleFaviconSrc } from "../../components/InlineReference/sampleFavicons";

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

// #region recipe: Links in markdown
function LinkedReply({ faviconSrc }: { faviconSrc?: (href: string) => string | undefined }) {
  // Product: <ReactMarkdown components={{ a: MarkdownLink, table: MarkdownTable }}>
  return (
    <MarkdownContent faviconSrc={faviconSrc}>
      <p>
        See the <MarkdownLink href="https://docs.example.com/guide/first-run/">first-run guide</MarkdownLink>,{" "}
        <MarkdownLink href="https://github.com/example-org/notes/issues/512">https://github.com/example-org/notes/issues/512</MarkdownLink>{" "}
        or mail <MarkdownLink href="mailto:support@example.com">support@example.com</MarkdownLink>.
      </p>
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
  recipes: [
    { name: "Document with code and a table", description: "Wrap markdown output; MarkdownCodeFrame and MarkdownTable replace pre and table.", render: () => <SpecExcerpt /> },
    { name: "Links in markdown", description: "MarkdownLink replaces a: http(s) links become external InlineReferences with favicons from faviconSrc; mailto and relative links stay plain.", render: () => <LinkedReply faviconSrc={sampleFaviconSrc} /> },
  ],
  doDont: [
    {
      do: { caption: "Markdown rhythm comes from MarkdownContent.", render: () => <SpecExcerpt /> },
      dont: { caption: "Typo stacks for a document lose list and code styling.", render: () => <Stack gap="xs"><Typo.H2>Verification</Typo.H2><Typo.Body>- Run the checks</Typo.Body></Stack> },
    },
  ],
  content: ["Headings in sentence case; code blocks name their language."],
  accessibility: ["Real headings, lists and tables; streaming spans never move text (no layout shift).", "Links are real anchors; external ones open in the system browser with noopener and no referrer."],
  tokens: ["--line-height-document", "--typo-code-size", "--syntax-keyword", "--radius-panel", "--accent-text", "--favicon-plate"],
};
