import { useEffect, useRef, useState } from "react";
import { api } from "@/app/api";

import type { ImageUsageView } from "./imageUsageTypes";

interface ImageUsageSnapshot {
  revision: number;
  selected: unknown | null;
  ranges: Map<number, ImageUsageView>;
}

/** The thirty-day range also determines visibility when no model is selected. */
export function useImageUsage(days: number, revision: number) {
  const cache = useRef<ImageUsageSnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<ImageUsageSnapshot | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const current = cache.current;
    if (current?.revision === revision && current.ranges.has(days)) return;
    setError(false);
    const ranges = [...new Set([30, days])];
    Promise.all([
      api<{ selected: unknown | null }>("/settings/image-model"),
      Promise.all(ranges.map(range => api<ImageUsageView>(`/usage/images?days=${range}`))),
    ]).then(([settings, views]) => {
      if (cancelled) return;
      const next = { revision, selected: settings.selected, ranges: new Map(views.map(view => [view.days, view])) };
      cache.current = next;
      setSnapshot(next);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [days, revision]);
  return {
    visible: snapshot !== null && (snapshot.selected !== null || Boolean(snapshot.ranges.get(30)?.models.length)),
    view: snapshot?.ranges.get(days) ?? null,
    error,
  };
}
