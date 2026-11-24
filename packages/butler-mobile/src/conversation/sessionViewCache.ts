import { Directory, File, Paths } from "expo-file-system";
import type { SessionView } from "../../../butler-protocol/src/index.ts";

/** Messages per /session-view page; the conversation renders one page in its first pass. */
export const SESSION_PAGE = 50;

const memory = new Map<string, SessionView>();
const KEEP = 30;
const dir = () => new Directory(Paths.cache, "session-views");
// One flat directory; the encoded name always contains "%0A", so no Butler or chat id can name a path outside it.
const file = (butlerId: string, id: string) => new File(dir(), `${encodeURIComponent(`${butlerId}\n${id}`)}.json`);

/** The last view shown for this chat, from memory or disk. */
export function cachedSessionView(butlerId: string, id: string): SessionView | null {
  const key = `${butlerId}\n${id}`;
  const remembered = memory.get(key);
  if (remembered) return remembered;
  try {
    const cached = file(butlerId, id);
    if (!cached.exists) return null;
    const view = JSON.parse(cached.textSync()) as SessionView;
    memory.set(key, view);
    return view;
  } catch { return null; }
}

/** Remembers the view on each publish. */
export function rememberSessionView(butlerId: string, view: SessionView): void {
  memory.set(`${butlerId}\n${view.session_id}`, view);
}

/** Saves the last page when the chat closes and keeps the newest cache files. */
export function saveSessionView(butlerId: string, id: string): void {
  const view = memory.get(`${butlerId}\n${id}`);
  if (!view) return;
  try {
    const json = JSON.stringify({ ...view, messages: view.messages.slice(-SESSION_PAGE) });
    const directory = dir();
    directory.create({ intermediates: true, idempotent: true });
    void file(butlerId, id).write(json).then(() => {
      const files = directory.list().filter(entry => entry instanceof File);
      files.sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0));
      for (const cached of files.slice(KEEP)) cached.delete();
    }).catch(() => {});
  } catch {}
}

/** Forgets every cached chat on unpair. */
export function clearSessionViews(): void {
  memory.clear();
  try {
    const directory = dir();
    if (directory.exists) directory.delete();
  } catch {}
}
