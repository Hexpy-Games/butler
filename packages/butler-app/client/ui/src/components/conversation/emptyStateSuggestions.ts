import { appCopy } from "@/app/copy.ts";
import { useComposerStore } from "./composerStore.ts";

export function generalFallbackSuggestions() { return appCopy.briefing.general.suggestions; }
export function projectFallbackSuggestions(name: string) { return appCopy.briefing.projectSuggestions(name); }

/** Puts a template in an empty composer, caret at the end, for the user to finish; a started draft is kept. */
export function fillComposerWithTemplate(text: string) {
  const composer = useComposerStore.getState();
  const empty = !composer.text.trim() && !composer.contentParts;
  if (empty && composer.appendDraftText) return composer.appendDraftText(text);
  if (empty) composer.setText(text);
  composer.textAreaRef?.current?.focus();
}
