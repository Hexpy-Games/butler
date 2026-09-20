import type { Root } from "mdast";

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

// CommonMark treats a closing ** after punctuation and before a word character
// as an opening delimiter, leaving the intended emphasis as literal text.
const PUNCTUATION_BOLD_WITH_SUFFIX = /\*\*([^\n*]+?\p{P})\*\*(?=[\p{L}\p{N}])/gu;

export function remarkPunctuationBoldSuffix() {
  return (tree: Root, file: { value: string | Uint8Array }) => {
    const source = String(file.value);

    function visit(node: MarkdownNode) {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }

        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        // Escaped stars and entities have different source and parsed text.
        if (start === undefined || end === undefined || source.slice(start, end) !== child.value) {
          return [child];
        }

        const result: MarkdownNode[] = [];
        let cursor = 0;
        for (const match of child.value.matchAll(PUNCTUATION_BOLD_WITH_SUFFIX)) {
          const index = match.index;
          if (index > cursor) result.push({ type: "text", value: child.value.slice(cursor, index) });
          result.push({ type: "strong", children: [{ type: "text", value: match[1] }] });
          cursor = index + match[0].length;
        }
        if (cursor === 0) return [child];
        if (cursor < child.value.length) result.push({ type: "text", value: child.value.slice(cursor) });
        return result;
      });
    }

    visit(tree as MarkdownNode);
  };
}
