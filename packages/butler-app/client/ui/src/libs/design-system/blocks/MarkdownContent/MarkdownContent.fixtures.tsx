import { MarkdownContent } from "./MarkdownContent";

export function MarkdownContentFixture() {
  return (
    <MarkdownContent>
      <h1>Project spec</h1>
      <p>Markdown content keeps document rhythm inside the design system.</p>
      <code>project-ledger check</code>
      <ul>
        <li>Readable list spacing</li>
        <li>Clear item separation</li>
      </ul>
      <pre>
        <code>{"bun test tests/unit/app-client-design.test.ts"}</code>
      </pre>
      <h1>Next document section</h1>
      <p>A new major section is separated from the previous content.</p>
      <h2>Implementation</h2>
      <p>Subsections retain a smaller, consistent section gap.</p>
    </MarkdownContent>
  );
}
