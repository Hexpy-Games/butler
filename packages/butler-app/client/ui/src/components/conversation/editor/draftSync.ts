import { sendComposingLease } from "../sendComposingLease";
import { SKIP_DOM_SELECTION_TAG, type LexicalEditor } from "lexical";
import { writeCachedComposerDraft } from "@/app/composerDraftCache.ts";
import { messageContentText, type MessageContent } from "@/app/messageContent";
import { useComposerStore } from "../composerStore";
import { afterComposition, hasHeldWrites } from "./composition";
import { $readComposerContent, $replaceComposerContent } from "./serialization";

function storeDraft(): MessageContent {
  const { contentParts, text } = useComposerStore.getState();
  return contentParts ?? { version: 1, parts: text ? [{ type: "text", text }] : [] };
}

const same = (left: MessageContent, right: MessageContent) => JSON.stringify(left) === JSON.stringify(right);

/** Puts the store's draft into the editor. Mid-composition that would make the IME commit early, so it waits. */
export function syncEditorFromStore(editor: LexicalEditor): void {
  const differs = () => !same(editor.getEditorState().read($readComposerContent), storeDraft());
  if (!differs()) return;
  afterComposition(editor, () => {
    if (differs()) editor.update(() => $replaceComposerContent(storeDraft()), { tag: SKIP_DOM_SELECTION_TAG });
  });
}

/** Saves the editor's content as the draft of the session this editor belongs to. */
export function saveDraftFromEditor(editor: LexicalEditor, sessionId: string, content: MessageContent): void {
  // A store write waiting for the IME is newer than the editor until it runs.
  if (hasHeldWrites(editor)) return;
  const state = useComposerStore.getState();
  if (state.draftSessionId !== sessionId) {
    // The editor outlived its session (text committed while it unmounts).
    writeCachedComposerDraft(sessionId, messageContentText(content), content.parts.some(part => part.type !== "text") ? content : undefined);
    return;
  }
  if (!same(content, storeDraft())) {
    state.setContentParts(content);
    if (editor.getRootElement()?.contains(document.activeElement)) sendComposingLease(sessionId, messageContentText(content));
  }
}
