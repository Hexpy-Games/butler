import { locateExactText, type ExactTextLocation } from "./exact-text-locator.ts";

type ExactEdit = { path: string; oldText: string; newText: string; startLine?: number };

/** Plan exact edits against preceding in-memory results; never mutates files. */
export function prepareOrderedExactEdits(
  edits: readonly ExactEdit[],
  initialText: ReadonlyMap<string, string>,
):
  | { ok: true; locations: ExactTextLocation[]; files: Map<string, { beforeText: string; afterText: string }> }
  | { ok: false; index: number; path: string; error: string; occurrenceCount: number } {
  const files = new Map<string, { beforeText: string; afterText: string }>();
  const locations: ExactTextLocation[] = [];
  for (const [index, edit] of edits.entries()) {
    const prior = files.get(edit.path);
    const text = prior?.afterText ?? initialText.get(edit.path);
    if (text === undefined) throw new Error("Exact edit target was not observed");
    const location = locateExactText({ text, oldText: edit.oldText, startLine: edit.startLine });
    if (!location.ok) return { ...location, index, path: edit.path };
    locations.push(location.value);
    files.set(edit.path, {
      beforeText: prior?.beforeText ?? text,
      afterText: text.slice(0, location.value.offset) + edit.newText + text.slice(location.value.offset + edit.oldText.length),
    });
  }
  return { ok: true, locations, files };
}
