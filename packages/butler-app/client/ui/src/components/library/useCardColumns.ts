import { useEffect, useState } from "react";

/** The card grid's column count at the page's width: 2 on a phone page (<36rem), 3, or 4 from 48rem (Grid's compact/base/wide). */
export function useCardColumns() {
  const [node, ref] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const columns = width < 36 * rem ? 2 : width < 48 * rem ? 3 : 4;
  return { ref, columns };
}
