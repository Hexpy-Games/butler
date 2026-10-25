import { fromMarkdown } from "mdast-util-from-markdown";
import { createContext, useContext, type JSX } from "react";
import { $createNodeSelection, $setSelection, $getRoot, DecoratorNode, type NodeKey, type SerializedLexicalNode } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import { BlockActionFrame, DocumentBlockEmbed, MarkdownContent, MediaFrame } from "@/butler-ds";
import { AnswerBlocks } from "../conversation/AnswerBlocks";
import type { AnswerBlocksView } from "../../../../shared/answer-blocks-view";
import { toMarkdown } from "../../../../shared/answer-blocks-markdown";
import { appCopy } from "@/app/copy";
import { api } from "@/app/api";
import { gatewayImageSource } from "@/app/messageFileUrls";
import { notifyStatus } from "@/app/notifications";
import { libraryChanged } from "@/app/libraryEvents";
import type { DocumentAsset } from "./documentApi";
export const DocumentOperations = createContext<{ id: string; flush: () => Promise<void> }>({ id: "", flush: async () => undefined });
export const DocumentAssets = createContext<DocumentAsset[]>([]);
type UnitJSON = SerializedLexicalNode & { raw: string };
function decorateImages(spec: AnswerBlocksView, assets: DocumentAsset[]): AnswerBlocksView {
  return JSON.parse(JSON.stringify(spec), (_key, value) => {
    if (value && typeof value === "object" && typeof value.img === "string") {
      const asset = assets.find(asset => asset.id === value.img);
      if (asset) return { ...value, image_url: asset.signed_url ?? asset.url, image_width: asset.image_width, image_height: asset.image_height };
    }
    return value;
  });
}
function Unit({ nodeKey, raw, type }: { nodeKey: NodeKey; raw: string; type: string }) {
  const [selected] = useLexicalNodeSelection(nodeKey);
  const [editor] = useLexicalComposerContext();
  const assets = useContext(DocumentAssets);
  const operations = useContext(DocumentOperations);
  let content: JSX.Element;
  if (type === "document-blocks") {
    const node = fromMarkdown(raw).children[0];
    const spec = JSON.parse(node?.type === "code" ? node.value : "{}") as AnswerBlocksView;
    const copy = appCopy.conversation.answerBlocks;
    const save = async () => {
      await operations.flush();
      const index = editor.getEditorState().read(() => $getRoot().getChildren().filter(node => node instanceof RawMarkdownNode && fromMarkdown(node.getTextContent()).children.some(part => part.type === "code" && part.lang === "blocks")).findIndex(node => node.getKey() === nodeKey));
      await api(`/documents/${encodeURIComponent(operations.id)}/blocks/${index}`, { method: "POST" });
      libraryChanged(); notifyStatus(copy.savedToLibrary);
    };
    content = <BlockActionFrame actionsLabel={appCopy.browser.more} actions={[
      { label: copy.copy, onSelect: () => { void navigator.clipboard.writeText(toMarkdown(decorateImages(spec, assets), gatewayImageSource)); } },
      { label: copy.saveToLibrary, onSelect: () => { void save().catch(() => notifyStatus(appCopy.library.failed, { tone: "error" })); } },
    ]}><AnswerBlocks sets={[{ call_id: nodeKey, set_ids: [], spec: decorateImages(spec, assets) }]} preview /></BlockActionFrame>;
  } else if (type === "document-image") {
    const paragraph = fromMarkdown(raw).children[0];
    const image = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
    const asset = assets.find(asset => image?.type === "image" && asset.id === image.url);
    content = <MediaFrame src={gatewayImageSource(asset?.signed_url ?? asset?.url)} natural={asset?.image_width && asset?.image_height ? { width: asset.image_width, height: asset.image_height } : undefined} alt={image?.type === "image" ? image.alt ?? "" : ""} />;
  } else content = <MarkdownContent><pre>{raw}</pre></MarkdownContent>;
  return <div onMouseDown={event => { if (!(event.target as Element).closest("button,a,input")) event.preventDefault(); }}
    onClick={event => { if ((event.target as Element).closest("button,a,input")) return; event.stopPropagation(); editor.getRootElement()?.focus({ preventScroll: true });
      editor.update(() => { const selection = $createNodeSelection(); selection.add(nodeKey); $setSelection(selection); }); }}>
    <DocumentBlockEmbed selected={selected}>{content}</DocumentBlockEmbed>
  </div>;
}
/** Canonical Markdown units retain unknown syntax and frozen specs verbatim. */
export class RawMarkdownNode extends DecoratorNode<JSX.Element> {
  __raw: string;
  static getType() { return "document-raw"; }
  static clone(node: RawMarkdownNode) { return new RawMarkdownNode(node.__raw, node.__key); }
  constructor(raw = "", key?: NodeKey) { super(key); this.__raw = raw; }
  createDOM() { const element = document.createElement("div"); element.contentEditable = "false"; return element; }
  updateDOM() { return false; }
  isInline() { return false; }
  getTextContent() { return this.__raw; }
  exportJSON(): UnitJSON { return { ...super.exportJSON(), type: this.getType(), version: 1, raw: this.__raw }; }
  static importJSON(value: UnitJSON) { return new RawMarkdownNode(value.raw); }
  decorate() { return <Unit nodeKey={this.__key} raw={this.__raw} type={this.getType()} />; }
}
export class BlocksNode extends RawMarkdownNode {
  static getType() { return "document-blocks"; }
  static clone(node: BlocksNode) { return new BlocksNode(node.__raw, node.__key); }
  static importJSON(value: UnitJSON) { return new BlocksNode(value.raw); }
}
export class ImageNode extends RawMarkdownNode {
  static getType() { return "document-image"; }
  static clone(node: ImageNode) { return new ImageNode(node.__raw, node.__key); }
  static importJSON(value: UnitJSON) { return new ImageNode(value.raw); }
}
