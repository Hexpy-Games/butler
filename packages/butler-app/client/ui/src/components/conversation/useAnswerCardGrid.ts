import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { settleGrid } from "@/butler-ds";

type Columns = "1" | "2" | "3" | "4";
function cardColumns(grid: HTMLElement, count: number, open: boolean): Columns {
  const width = grid.getBoundingClientRect().width;
  const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
  let n = width < 560 ? 1 : Math.min(4, open ? 4 : count, Math.floor((width + gap) / (168 + gap)));
  if (!open) while (n > 1 && count % n === 1) n--;
  return String(Math.max(1, n)) as Columns;
}

/** Open lists keep intrinsic row heights; only the close edge settles their final layout. */
export function useAnswerCardGrid(count: number, open: boolean, reducedMotion: boolean) {
  const ref = useRef<HTMLElement>(null);
  const wasOpen = useRef(open);
  const settling = useRef(false);
  const [layout, setLayout] = useState<{ columns: Columns; settled: boolean }>({ columns: "1", settled: !open });
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const measure = () => {
      // Leave the close edge to settleGrid, including its opacity dip before reflow.
      if (settling.current || (wasOpen.current && !open)) return;
      const columns = cardColumns(grid, count, open);
      setLayout(previous => previous.columns === columns && previous.settled === !open ? previous : { columns, settled: !open });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [count, open]);
  useEffect(() => {
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    const grid = ref.current;
    if (!closing || !grid) return;
    const columns = cardColumns(grid, count, false);
    settling.current = true;
    settleGrid(grid, () => {
      settling.current = false;
      if (!wasOpen.current && ref.current === grid) setLayout({ columns, settled: true });
    }, {
      reflow: columns !== layout.columns, reducedMotion: reducedMotion || undefined,
    });
  }, [count, open, reducedMotion, layout.columns]);
  return { ref, ...layout };
}
