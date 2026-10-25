import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fromMarkdown } from "mdast-util-from-markdown";
import { MediaFrame, MarkdownContent, MarkdownLink, MarkdownTable, Typo, Stack } from "@/butler-ds";
import { AnswerBlocks } from "../conversation/AnswerBlocks";
import { gatewayImageSource } from "@/app/messageFileUrls";
import type { AnswerBlocksView, AnswerBlockView } from "../../../../shared/answer-blocks-view";
import type { EditableDocument } from "./documentApi";
/** Printing expands every tab in sequence, using the same answer renderer for the contents. */
function printable(spec: AnswerBlocksView): AnswerBlocksView {
  const blocks: AnswerBlockView[] = [];
  for (const block of spec.blocks) {
    if (block.type === "tabs") for (const tab of block.tabs) blocks.push({ type: "group", title: tab.label, blocks: tab.blocks });
    else blocks.push(block);
  }
  return { ...spec, blocks };
}
export function DocumentReadView({ doc, print = false }: { doc: EditableDocument; print?: boolean }) {
  const nodes = fromMarkdown(doc.body).children;
  return <div data-document-read-only={doc.id}><Stack gap="md">{nodes.map((node, index) => {
    const raw = doc.body.slice(node.position!.start.offset!, node.position!.end.offset!);
    if (node.type === "code" && node.lang === "blocks") {
      try {
        const spec = JSON.parse(node.value, (_key, value) => {
          if (value && typeof value === "object" && typeof value.img === "string") {
            const asset = doc.assets?.find(asset => asset.id === value.img);
            return { ...value, image_url: asset?.signed_url ?? asset?.url, image_width: asset?.image_width, image_height: asset?.image_height };
          }
          return value;
        }) as AnswerBlocksView;
        const view = print ? printable(spec) : spec;
        return <div key={index}>{view.blocks.map((block, i) => <Stack key={i} gap="sm">
          {print && block.type === "group" && block.title ? <Typo.H3>{block.title}</Typo.H3> : null}
          <AnswerBlocks sets={[{ call_id: String(index), set_ids: [], spec: { v: view.v, blocks: [block] } }]} preview />
        </Stack>)}</div>;
      } catch { /* Unknown fences remain visible. */ }
    }
    return <MarkdownContent key={index}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink, table: MarkdownTable,
      img: ({ src, alt }) => {
        const asset = doc.assets?.find(asset => asset.id === src);
        const url = gatewayImageSource(asset?.signed_url ?? asset?.url ?? src);
        return asset?.image_width && asset?.image_height
          ? <MediaFrame src={url} natural={{ width: asset.image_width, height: asset.image_height }} alt={alt} />
          : <img src={url} alt={alt} />;
      },
    }}>{raw}</ReactMarkdown></MarkdownContent>;
  })}</Stack></div>;
}
