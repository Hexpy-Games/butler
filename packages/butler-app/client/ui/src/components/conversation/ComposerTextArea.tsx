import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useCallback } from "react";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { appCopy } from "@/app/copy";
import { ComposerCardEditor, ComposerCardEditable, ComposerCardPlaceholder } from "@/butler-ds";
import { useComposerStore } from "./composerStore";
import { SessionReferenceNode } from "./editor/SessionReferenceNode";
import { ComposerEditorPlugin } from "./editor/ComposerEditorPlugin";

export const COMPOSER_MAX_AUTO_ROWS = 8;

export function ComposerTextArea({ placeholder }: { placeholder?: string }) {
  const sessionId = useComposerStore(state => state.draftSessionId);
  const setIsComposing = useComposerStore(state => state.setIsComposing);
  const handleKeyDown = useComposerStore(state => state.handleKeyDown);
  const large = useComposerStore(state => state.large);
  const textAreaRef = useComposerStore(state => state.textAreaRef);
  const attachEditor = useCallback((element: HTMLDivElement | null) => {
    if (textAreaRef) textAreaRef.current = element;
  }, [textAreaRef]);
  return (
    <LexicalComposer key={sessionId} initialConfig={{
      namespace: "butler-composer",
      nodes: [SessionReferenceNode],
      onError: error => { throw error; },
    }}>
      <ComposerCardEditor>
        <PlainTextPlugin
          contentEditable={<ComposerCardEditable><ContentEditable
            ref={attachEditor}
            aria-label={appCopy.composer.messageComposer}
            data-max-auto-rows={COMPOSER_MAX_AUTO_ROWS}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onKeyDown={handleKeyDown}
          /></ComposerCardEditable>}
          placeholder={<ComposerCardPlaceholder>{placeholder ?? (large ? appCopy.composer.placeholder : appCopy.composer.placeholderFollowUp)}</ComposerCardPlaceholder>}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </ComposerCardEditor>
      <HistoryPlugin />
      <ComposerEditorPlugin />
    </LexicalComposer>
  );
}
