import { CopyButton } from "../../components/CopyButton";
import { MessageFooter } from "../MessageRow";
import { MarkdownContent } from "./MarkdownContent";
import { MarkdownCodeFrame, MarkdownTable } from "./MarkdownParts";

/** Pre-highlighted sample: product code blocks get these `data-syntax` spans from lowlight. */
function HighlightedSample() {
  return (
    <code className="language-ts">
      <span data-syntax="keyword">import</span>{" { check } "}
      <span data-syntax="keyword">from</span>{" "}
      <span data-syntax="string">"project-ledger"</span>;{"\n\n"}
      <span data-syntax="comment">{"// Fails when a spec drifts from its plan."}</span>{"\n"}
      <span data-syntax="keyword">const</span>{" "}
      <span data-syntax="variable">result</span>{" = "}
      <span data-syntax="keyword">await</span>{" "}
      <span data-syntax="title">check</span>({"{ "}
      <span data-syntax="variable">project</span>:{" "}
      <span data-syntax="string">"butler"</span>, <span data-syntax="variable">strict</span>:{" "}
      <span data-syntax="number">true</span>{" });"}
    </code>
  );
}

export function MarkdownContentFixture() {
  return (
    <MarkdownContent>
      <h1>Project spec</h1>
      <p>
        Markdown content keeps document rhythm inside the design system. Inline
        {" "}<code>project-ledger check</code> and <a href="#spec">links</a> stay in the text flow.
      </p>
      <h2>Implementation</h2>
      <p>Subsections keep a smaller, consistent section gap without rules under headings.</p>
      <ul>
        <li>Readable list spacing</li>
        <li>
          Clear item separation
          <ul><li>Nested items keep the same rhythm</li></ul>
        </li>
      </ul>
      <ol>
        <li>Plan the change</li>
        <li>Verify it</li>
      </ol>
      <MarkdownCodeFrame
        language="ts"
        actions={(
          <MessageFooter>
            <CopyButton text="check" label="Copy code" copiedLabel="Copied" />
          </MessageFooter>
        )}
      >
        <HighlightedSample />
      </MarkdownCodeFrame>
      <blockquote><p>Quoted notes use a quiet rule and secondary text.</p></blockquote>
      <h3>Verification matrix</h3>
      <MarkdownTable>
        <thead>
          <tr><th>Check</th><th>Command</th><th>Scope</th><th>Owner</th><th>Last run</th><th>Result</th></tr>
        </thead>
        <tbody>
          <tr><td>Types</td><td><code>bun run typecheck</code></td><td>Workspace</td><td>Butler</td><td>2 minutes ago</td><td>Passed</td></tr>
          <tr><td>Design lint</td><td><code>bun run lint:design</code></td><td>UI package</td><td>Butler</td><td>5 minutes ago</td><td>Passed</td></tr>
        </tbody>
      </MarkdownTable>
    </MarkdownContent>
  );
}
