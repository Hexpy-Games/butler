import { fromMarkdown } from "mdast-util-from-markdown";
import type { RootContent } from "mdast";
import { $createParagraphNode, $getNodeByKey, $getRoot, type LexicalNode } from "lexical";
import { $convertToMarkdownString, $generateNodesFromMarkdownString, HEADING, UNORDERED_LIST, ORDERED_LIST, BOLD_STAR, BOLD_UNDERSCORE, ITALIC_STAR, ITALIC_UNDERSCORE, LINK } from "@lexical/markdown";
import { BlocksNode, ImageNode, RawMarkdownNode } from "./DocumentNodes";
import { importTextPart } from "./documentTextImport";
export const DOCUMENT_TRANSFORMERS = [HEADING, UNORDERED_LIST, ORDERED_LIST, BOLD_STAR, BOLD_UNDERSCORE, ITALIC_STAR, ITALIC_UNDERSCORE, LINK];
interface Snapshot { raw: string; modified: boolean; gap: string }
export interface MarkdownSource { nodes: Map<string, Snapshot>; prefix: string }
function representable(node: RootContent | { type: string; children?: unknown[] }): boolean {
  if (!["paragraph", "heading", "list", "listItem", "text", "strong", "emphasis", "link"].includes(node.type)) return false;
  if (node.type === "heading" && "depth" in node && Number(node.depth) > 3) return false;
  return !("children" in node) || !node.children || node.children.every(child => representable(child as RootContent));
}
function importPart(raw: string, part: RootContent): LexicalNode[] {
  if (part.type === "code" && part.lang === "blocks") {
    try { const spec = JSON.parse(part.value); if (spec.v === 2 && Array.isArray(spec.blocks)) return [new BlocksNode(raw)]; } catch { /* Preserve invalid/unknown fences as raw Markdown. */ }
  }
  if (part.type === "paragraph" && part.children.length === 1 && part.children[0]?.type === "image" && part.children[0].url.startsWith("img_")) return [new ImageNode(raw)];
  if (!representable(part)) return [new RawMarkdownNode(raw)];
  if (part.type === "paragraph") return [importTextPart(part)];
  return $generateNodesFromMarkdownString(raw, DOCUMENT_TRANSFORMERS);
}
/** Keep source slices, including inter-node whitespace, until the corresponding node changes. */
export function importDocument(markdown: string): MarkdownSource {
  const root = $getRoot(); root.clear();
  const parts = fromMarkdown(markdown).children;
  const source: MarkdownSource = { nodes: new Map(), prefix: markdown.slice(0, parts[0]?.position?.start.offset ?? markdown.length) };
  const imported: LexicalNode[] = [];
  parts.forEach((part, index) => {
    const start = part.position!.start.offset!, end = part.position!.end.offset!;
    const raw = markdown.slice(start, end), nodes = importPart(raw, part);
    imported.push(...nodes);
    nodes.forEach((node, i) => source.nodes.set(node.getKey(), { raw: i === 0 ? raw : "", modified: false, gap: i === nodes.length - 1 ? markdown.slice(end, parts[index + 1]?.position?.start.offset ?? markdown.length) : "" }));
  });
  root.append(...(imported.length ? imported : [$createParagraphNode()]));
  return source;
}
export function nodeMarkdown(node: LexicalNode) {
  if (node instanceof RawMarkdownNode) return node.getTextContent();
  // The exporter accepts an element whose children are the top-level nodes.
  const wrapper = { getChildren: () => [node] } as Parameters<typeof $convertToMarkdownString>[1];
  return $convertToMarkdownString(DOCUMENT_TRANSFORMERS, wrapper);
}
/** Only dirty nodes and their ancestors are visited on editor updates; root order is read on export. */
export function markDocumentChanges(source: MarkdownSource, keys: Iterable<string>) {
  for (const key of keys) {
    const node = $getNodeByKey(key);
    if (!node) { source.nodes.delete(key); continue; }
    const top = node.getTopLevelElement();
    const snapshot = top ? source.nodes.get(top.getKey()) : undefined;
    if (snapshot) snapshot.modified = true;
  }
}
export function exportDocument(source: MarkdownSource): string {
  const children = $getRoot().getChildren();
  return source.prefix + children.map((node, index) => {
    const prior = source.nodes.get(node.getKey());
    const raw = prior && !prior.modified ? prior.raw : nodeMarkdown(node);
    const gap = index === children.length - 1 ? prior?.gap ?? "" : prior?.gap || "\n\n";
    source.nodes.set(node.getKey(), { raw, gap, modified: false });
    return raw + gap;
  }).join("");
}
