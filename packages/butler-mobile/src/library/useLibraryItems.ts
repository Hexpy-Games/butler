import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryItem, LibraryKind, LibraryPage } from "../../../butler-protocol/src/index.ts";
import { useConversation } from "@/conversation/live";
import { libraryQuery } from "./libraryItems";

export function useLibraryItems(kind: LibraryKind, q: string) {
  const { client, reconcile } = useConversation();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false);
  const next = useRef<string | null>(null), latest = useRef(0), pending = useRef(false);
  const load = useCallback(async (cursor: string) => {
    const request = ++latest.current;
    pending.current = true;
    setLoading(true); setFailed(false);
    try {
      const page = await client!.request<LibraryPage>(`/library?${libraryQuery(kind, q, cursor)}`);
      if (request !== latest.current) return;
      setItems(old => cursor ? [...old, ...page.items] : page.items);
      next.current = page.next_cursor ?? null;
    } catch { if (request === latest.current) setFailed(true); }
    finally { if (request === latest.current) { pending.current = false; setLoading(false); } }
  }, [client, kind, q]);
  const reload = useCallback(() => load(""), [load]);
  useEffect(() => { setItems([]); next.current = null; }, [kind, q]);
  useEffect(() => {
    void reload();
    return () => { latest.current++; };
  }, [reload, reconcile]);
  const more = () => { if (next.current && !pending.current) void load(next.current); };
  return { items, loading, failed, more, reload, hasMore: next.current !== null };
}
