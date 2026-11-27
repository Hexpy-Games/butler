export type CommandPaletteResult = { id: string; kind: string; title: string; subtitle?: string };
export type SearchHit = { id: string; kind: "chat" | "project_session"; title: string; subtitle: string };

export function chatHits(results: CommandPaletteResult[], kindLabels: { chat: string; project_session: string }, untitled: string, general: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const { id, kind, title, subtitle } of results) {
    if (kind !== "chat" && kind !== "project_session") continue;
    const location = subtitle?.trim();
    const literal = kind === "chat" ? "Chat" : "Project chat";
    hits.push({
      id, kind,
      title: id === "general" ? general : title.trim() ? title : untitled,
      subtitle: !location || location === literal ? kindLabels[kind] : location,
    });
  }
  return hits;
}
