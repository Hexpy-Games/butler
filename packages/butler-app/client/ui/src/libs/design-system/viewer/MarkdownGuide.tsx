import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownContent, MarkdownLink } from "../blocks/MarkdownContent";

const COMPONENTS = { a: MarkdownLink };

export function MarkdownGuide({ markdown }: { markdown: string }) {
  return (
    <MarkdownContent>
      <ReactMarkdown components={COMPONENTS} remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </MarkdownContent>
  );
}
