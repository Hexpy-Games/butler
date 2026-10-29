import { diffArrays } from "diff";

type Hunk = { start: number; end: number; lines: string[] };
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
function hunks(base: string[], next: string[]): Hunk[] {
  const result: Hunk[] = [];
  let position = 0, pending: Hunk | undefined;
  for (const part of diffArrays(base, next)) {
    if (!part.added && !part.removed) {
      if (pending) result.push(pending);
      pending = undefined; position += part.value.length;
    } else {
      pending ??= { start: position, end: position, lines: [] };
      if (part.removed) { position += part.value.length; pending.end = position; }
      else pending.lines.push(...part.value);
    }
  }
  if (pending) result.push(pending);
  return result;
}
function overlaps(a: Hunk, b: Hunk) {
  if (a.start === a.end || b.start === b.end) return a.start <= b.end && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}
/** Line-based diff3. Conflicts retain the user's hunk; independent remote hunks survive. */
export function mergeDocument(base: string, ours: string, theirs: string): string {
  if (base === ours) return theirs;
  if (base === theirs || ours === theirs) return ours;
  const original = lines(base), local = hunks(original, lines(ours));
  const remote = hunks(original, lines(theirs)).filter(hunk => !local.some(own => overlaps(own, hunk)));
  const changes = [...local, ...remote].sort((a, b) => a.start - b.start);
  const result: string[] = [];
  let cursor = 0;
  for (const hunk of changes) { result.push(...original.slice(cursor, hunk.start), ...hunk.lines); cursor = hunk.end; }
  return [...result, ...original.slice(cursor)].join("");
}
