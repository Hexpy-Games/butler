import { openDocument, type EditableDocument } from "../documents/documentApi";
import { createContext, useContext, useRef, type ReactNode } from "react";
import type { AnswerBlockView } from "../../../../shared/answer-blocks-view";
import { toMarkdown } from "../../../../shared/answer-blocks-markdown";
import { BlockActionFrame, flySaveToTarget, type OverflowActionMenuItem } from "@/butler-ds";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { gatewayImageSource } from "@/app/messageFileUrls";
import { libraryChanged } from "@/app/libraryEvents";
import { notifyStatus } from "@/app/notifications";
import { openDetail } from "../library/libraryNav";
import type { LibraryItem } from "../browser/libraryStore";
import { runAnswerAction } from "./answerBlockActions";

export interface AnswerBlockOrigin { session?: string; message?: string; reply?: string; saved?: boolean; preview?: boolean }
export const AnswerBlockOriginContext = createContext<AnswerBlockOrigin>({});

function visibleLibraryTarget(): Element | null {
  const target = document.querySelector('[data-flight-target="library"]');
  const box = target?.getBoundingClientRect();
  return box && box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0
    && box.top < innerHeight && box.left < innerWidth ? target : null;
}

async function makeDocument(block: AnswerBlockView, origin: AnswerBlockOrigin) {
  // Signed URLs are transport metadata, never part of the editable snapshot.
  const spec = JSON.stringify({ v: 2, blocks: [block] }, (key, value) => key === "image_url" ? undefined : value);
  const title = (block.title || origin.reply?.trim().split(/\s+/u).slice(0, 10).join(" ") || block.type).slice(0, 200);
  const doc = await api<EditableDocument>("/documents", { method: "POST", body: JSON.stringify({ title, body: `\`\`\`blocks\n${spec}\n\`\`\``,
    author: "user", chat_id: origin.session, message_id: origin.message }) });
  libraryChanged();
  openDocument({ ...doc, chat_id: doc.chat_id ?? origin.session });
}

export function AnswerBlockFrame({ block, path, child, children }: { block: AnswerBlockView; path: string; child?: boolean; children: ReactNode }) {
  const origin = useContext(AnswerBlockOriginContext);
  const ref = useRef<HTMLDivElement>(null);
  const copy = appCopy.conversation.answerBlocks;
  const save = async () => {
    const item = await api<LibraryItem>("/library/blocks", { method: "POST", body: JSON.stringify({ message_id: origin.message, path }) });
    libraryChanged();
    if (ref.current) flySaveToTarget(ref.current, visibleLibraryTarget());
    notifyStatus(copy.savedToLibrary, { action: { label: appCopy.library.open, onClick: () => openDetail(item, { kind: "library", section: "scrap" }) } });
  };
  const actions: OverflowActionMenuItem[] = origin.preview ? [] : [
    ...(!origin.saved && origin.message ? [{ label: copy.saveToLibrary, onSelect: () => runAnswerAction(save) }] : []),
    { label: copy.makeDocument, onSelect: () => runAnswerAction(() => makeDocument(block, origin)) },
    { label: copy.copy, onSelect: () => runAnswerAction(async () => {
      await navigator.clipboard.writeText(toMarkdown({ v: 2, blocks: [block] }, gatewayImageSource));
      notifyStatus(copy.copied);
    }) },
  ];
  return <BlockActionFrame ref={ref} title={block.title} level={child ? "child" : "block"} actions={actions} actionsLabel={appCopy.browser.more}
    data-answer-block={block.type} data-answer-path={path}>{children}</BlockActionFrame>;
}
