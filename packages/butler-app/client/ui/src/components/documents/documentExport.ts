import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";
import { toMarkdown } from "../../../../shared/answer-blocks-markdown";
import type { AnswerBlocks } from "../../../../shared/app-contracts";
export const documentFileName = (title: string) => title.replace(/[<>:"/\\|?*]/gu, "_").split("").map(char => char.charCodeAt(0) < 32 ? "_" : char).join("").replace(/[. ]+$/u, "").slice(0, 180) || "document";
function images(node: Root | RootContent, result: { start: number; end: number; id: string; alt: string; title?: string | null }[]) {
  if (node.type === "image" && node.url.startsWith("img_")) result.push({ start: node.position!.start.offset!, end: node.position!.end.offset!, id: node.url, alt: node.alt ?? "", title: node.title });
  if ("children" in node) node.children.forEach(child => images(child as RootContent, result));
}
/** Standalone export replaces only fences and image destinations; other Markdown stays exact. */
export async function exportDocumentMarkdown(body: string, imageData: (id: string) => Promise<string>): Promise<string> {
  const tree = fromMarkdown(body), replacements: { start: number; end: number; text: string }[] = [];
  for (const node of tree.children) {
    if (node.type !== "code" || node.lang !== "blocks") continue;
    const spec = JSON.parse(node.value) as AnswerBlocks;
    const ids = new Set<string>();
    JSON.stringify(spec, (key, value) => { if (key === "img" && typeof value === "string") ids.add(value); return value; });
    const data = new Map(await Promise.all([...ids].map(async id => [id, await imageData(id)] as const)));
    replacements.push({ start: node.position!.start.offset!, end: node.position!.end.offset!, text: toMarkdown(JSON.parse(JSON.stringify(spec), (_key, value) => value && typeof value === "object" && typeof value.img === "string" ? { ...value, image_url: data.get(value.img) } : value)) });
  }
  const embedded: { start: number; end: number; id: string; alt: string; title?: string | null }[] = []; images(tree, embedded);
  for (const image of embedded) {
    const escape = (text: string) => text.replace(/([\\[\]"])/gu, "\\$1");
    const title = image.title ? ` "${escape(image.title)}"` : "";
    replacements.push({ ...image, text: `![${escape(image.alt)}](${await imageData(image.id)}${title})` });
  }
  let result = body;
  for (const part of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, part.start) + part.text + result.slice(part.end);
  return result;
}
