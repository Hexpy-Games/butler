import { useLayoutEffect, useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useAppLocale } from "@/i18n";
import { useConversation } from "./live";
import { chatHits, type CommandPaletteResult, type SearchHit } from "./search";

type SearchState = { state: "idle" | "loading" | "results" | "empty" | "failed"; hits: SearchHit[] };

export function useChatSearch(query: string): SearchState & { retry(): void } {
  const { client } = useConversation();
  const app = getAppCopy(useAppLocale());
  const trimmed = query.trim();
  const [outcome, setOutcome] = useState<SearchState>({ state: "idle", hits: [] });
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(() => {
    if (!trimmed) {
      setOutcome({ state: "idle", hits: [] });
      return;
    }
    setOutcome(previous => ({ state: "loading", hits: previous.hits }));
    if (!client) return;

    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const { results } = await client.request<{ results: CommandPaletteResult[] }>("/command-palette?query=" + encodeURIComponent(trimmed));
        if (stale) return;
        const hits = chatHits(results, app.commandPalette.kindLabels, app.mobile.conversations.untitled, app.space.general);
        setOutcome({ state: hits.length ? "results" : "empty", hits });
      } catch {
        if (!stale) setOutcome({ state: "failed", hits: [] });
      }
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [trimmed, client, attempt, app]);

  return { ...outcome, retry: () => setAttempt(previous => previous + 1) };
}
