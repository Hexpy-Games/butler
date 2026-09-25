import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownContent } from "../blocks/MarkdownContent";

export function MarkdownGuide({ markdown }: { markdown: string }) {
  return (
    <MarkdownContent>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </MarkdownContent>
  );
}
