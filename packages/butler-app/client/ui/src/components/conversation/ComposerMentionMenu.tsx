import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { COMMAND_PRIORITY_CRITICAL, KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND, KEY_TAB_COMMAND, mergeRegister, type LexicalCommand } from "lexical";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store";
import { appShellTheme } from "@/app/utils";
import { Briefcase, MessageSquare, Notebook, Popover, PopoverAnchor, PopoverContent, SuggestionItemRow, SuggestionList } from "@/butler-ds";
import { useComposerStore } from "./composerStore";
import { mentionCandidates, rankMentions, type MentionCandidate } from "./mentionCandidates";
import { $createSessionReferenceNode } from "./editor/SessionReferenceNode";
import { $createProjectReferenceNode } from "./editor/ProjectReferenceNode";
import { $mentionToken, mentionAnchorRect, replaceMentionToken, sameToken, type MentionToken } from "./editor/mentionToken";
import { isComposerComposing } from "./editor/composition";

const LIST_ID = "composer-mention-list";

/** The `@` word under the caret; null when the caret is elsewhere. */
function useMentionToken(): MentionToken | null {
  const [editor] = useLexicalComposerContext();
  const [token, setToken] = useState<MentionToken | null>(null);
  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    const next = editorState.read(() => (editor.isEditable() ? $mentionToken() : null));
    setToken(current => (sameToken(current, next) ? current : next));
  }), [editor]);
  return token;
}

/**
 * Typing `@` in the composer suggests conversations and projects at the `@`; the text after it is the
 * query. Arrows move, Enter or Tab inserts the reference chip, Escape closes until the caret leaves the word.
 */
export function ComposerMentionMenu() {
  useAppLocale();
  const [editor] = useLexicalComposerContext();
  const token = useMentionToken();
  const navigation = useButlerStore(state => state.navigation);
  const settings = useButlerStore(state => state.settings);
  const currentSessionId = useComposerStore(state => state.draftSessionId);
  const candidates = useMemo(() => mentionCandidates(navigation, currentSessionId), [navigation, currentSessionId]);
  const items = useMemo(() => (token ? rankMentions(candidates, token.query) : []), [candidates, token]);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const open = Boolean(token) && !dismissed && items.length > 0;
  useEffect(() => { if (!token) setDismissed(false); }, [token]);
  useEffect(() => setActive(0), [token?.query, token?.key, token?.start]);

  // The chip replaces whatever @word is under the caret once the IME is idle (see replaceMentionToken).
  const choose = (item: MentionCandidate) => replaceMentionToken(editor, () => (item.kind === "project"
    ? $createProjectReferenceNode(item.id, item.title)
    : $createSessionReferenceNode(item.id, item.title)));
  // A key can arrive before the menu re-renders a just-committed syllable: rank the word the editor holds now.
  const pick = () => {
    const now = editor.getEditorState().read(() => $mentionToken());
    if (!now) return undefined;
    return now.query === token?.query ? items[active] : rankMentions(candidates, now.query)[0];
  };
  const latest = useRef({ open, items, pick, choose });
  latest.current = { open, items, pick, choose };
  const dismiss = useCallback(() => setDismissed(true), []);
  useMentionKeys(latest, setActive, dismiss);
  useComboboxAttributes(open ? `${LIST_ID}-${active}` : null);

  const anchor = useRef({ getBoundingClientRect: () => new DOMRect() });
  if (!token) return null;
  anchor.current = { getBoundingClientRect: () => mentionAnchorRect(editor, token) };
  return (
    <Popover open={open}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent side="top" align="start" sideOffset={6} density="list" presentation="popover" theme={appShellTheme(settings)}
        data-test-class="composer-mention-menu" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
        onInteractOutside={event => { if (!editor.getRootElement()?.contains(event.target as Node)) dismiss(); }}>
        <SuggestionList id={LIST_ID} label={appCopy.composer.mentionList}>
          {items.map((item, index) => (
            <SuggestionItemRow key={`${item.kind}:${item.id}`} id={`${LIST_ID}-${index}`} icon={mentionIcon(item)} title={item.title}
              meta={item.kind === "project" ? appCopy.composer.mentionProject : item.projectName} matchMeta={item.inProject} query={token?.query}
              active={index === active} onSelect={() => choose(item)} />
          ))}
        </SuggestionList>
      </PopoverContent>
    </Popover>
  );
}

/** While the menu is open the editor points at the list and its highlighted row, like a combobox field. */
function useComboboxAttributes(activeOptionId: string | null) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root || !activeOptionId) return;
    root.setAttribute("aria-controls", LIST_ID);
    root.setAttribute("aria-activedescendant", activeOptionId);
    return () => { root.removeAttribute("aria-controls"); root.removeAttribute("aria-activedescendant"); };
  }, [activeOptionId, editor]);
}

function mentionIcon(item: MentionCandidate) {
  if (item.kind === "project") return <Briefcase size="md" />;
  return item.inProject ? <Notebook size="md" /> : <MessageSquare size="md" />;
}

type MentionState = { open: boolean; items: MentionCandidate[]; pick: () => MentionCandidate | undefined; choose: (item: MentionCandidate) => void };

/** Keys go to the open menu before the composer's own Enter (send) and arrow handling; keys while the IME composes never do. */
function useMentionKeys(state: { current: MentionState }, setActive: (update: (index: number) => number) => void, dismiss: () => void) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    /** `act` returns false when the key is not the menu's after all. */
    const handle = <T extends KeyboardEvent | null>(command: LexicalCommand<T>, act: (menu: MentionState) => boolean) =>
      editor.registerCommand(command, (event: T) => {
        const menu = state.current;
        if (!menu.open || !event || event.isComposing || event.keyCode === 229 || isComposerComposing(editor)) return false;
        if (event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)) return false;
        if (!act(menu)) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      }, COMMAND_PRIORITY_CRITICAL);
    const move = (step: number) => (menu: MentionState) => {
      setActive(index => (index + step + menu.items.length) % menu.items.length);
      return true;
    };
    const choose = (menu: MentionState) => {
      const item = menu.pick();
      if (item) menu.choose(item);
      return Boolean(item);
    };
    return mergeRegister(
      handle(KEY_ARROW_DOWN_COMMAND, move(1)),
      handle(KEY_ARROW_UP_COMMAND, move(-1)),
      handle(KEY_ENTER_COMMAND, choose),
      handle(KEY_TAB_COMMAND, choose),
      handle(KEY_ESCAPE_COMMAND, () => { dismiss(); return true; }),
    );
  }, [dismiss, editor, setActive, state]);
}
