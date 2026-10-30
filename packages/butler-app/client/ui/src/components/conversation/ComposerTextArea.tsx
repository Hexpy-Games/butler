import { useAppLocale } from "@/app/copy.ts";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { memo, useCallback, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { mergeRegister } from "lexical";
import { appCopy } from "@/app/copy";
import { ComposerCardEditor, ComposerCardEditable, ComposerCardPlaceholder } from "@/butler-ds";
import { useComposerStore } from "./composerStore";
import { SessionReferenceNode } from "./editor/SessionReferenceNode";
import { ProjectSourceNode } from "./editor/ProjectSourceNode";
import { ProjectReferenceNode } from "./editor/ProjectReferenceNode";
import { ComposerEditorPlugin } from "./editor/ComposerEditorPlugin";
import { ComposerMentionMenu } from "./ComposerMentionMenu";
import { isComposerComposing, subscribeComposing } from "./editor/composition";

export const COMPOSER_MAX_AUTO_ROWS = 8;

// Lexical shows its placeholder while its own text is empty, but an IME composing on an
// empty line writes only the DOM until it is idle. Composing text is text.
function ComposerPlaceholder({ children }: { children: ReactNode }) {
  const [editor] = useLexicalComposerContext();
  const composing = useSyncExternalStore(
    useCallback((listener: () => void) => mergeRegister(editor.registerUpdateListener(listener), subscribeComposing(editor, listener)), [editor]),
    () => isComposerComposing(editor));
  return composing ? null : <ComposerCardPlaceholder>{children}</ComposerCardPlaceholder>;
}

export const ComposerTextArea = memo(function ComposerTextArea({ placeholder }: { placeholder?: string }) {
  useAppLocale();
  const sessionId = useComposerStore(state => state.draftSessionId);
  const setIsComposing = useComposerStore(state => state.setIsComposing);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) =>
    useComposerStore.getState().handleKeyDown(event), []);
  const large = useComposerStore(state => state.large);
  const textAreaRef = useComposerStore(state => state.textAreaRef);
  const attachEditor = useCallback((element: HTMLDivElement | null) => {
    if (textAreaRef) textAreaRef.current = element;
  }, [textAreaRef]);
  return (
    <LexicalComposer key={sessionId} initialConfig={{
      namespace: "butler-composer",
      nodes: [SessionReferenceNode, ProjectReferenceNode, ProjectSourceNode],
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
          placeholder={<ComposerPlaceholder>{placeholder ?? (large || sessionId.startsWith("dashboard:") ? appCopy.composer.placeholder : appCopy.composer.placeholderFollowUp)}</ComposerPlaceholder>}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </ComposerCardEditor>
      <HistoryPlugin />
      <ComposerEditorPlugin />
      <ComposerMentionMenu />
    </LexicalComposer>
  );
});
