import { useEffect, useState } from "react";

/** Observe the card's content box, including changes caused by sidebar layout. */
export function useWorkCardNarrow(card: HTMLDivElement | null): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!card) return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setNarrow(entry.contentRect.width < 480);
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, [card]);
  return narrow;
}
