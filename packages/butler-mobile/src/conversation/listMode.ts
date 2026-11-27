import { File, Paths } from "expo-file-system";
export type ListMode = "all" | "recent";
const file = () => new File(Paths.document, "home-list-mode.txt");
/** The home list's sort, saved on this phone; anything unreadable is 전체보기. */
export function loadListMode(): ListMode {
  try { const saved = file(); return saved.exists && saved.textSync().trim() === "recent" ? "recent" : "all"; } catch { return "all"; }
}
export function saveListMode(mode: ListMode): void {
  try { void file().write(mode).catch(() => {}); } catch {}
}
