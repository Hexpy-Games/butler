import { useLayoutEffect, useState, type ReactNode } from "react";

/**
 * Viewer-only: lays a window out at a fixed logical size (1440×900, 1100×800) and scales it down to the
 * story width, so a whole frame reads at every viewer width. The transform also contains the shell's
 * fixed drawers and overlays.
 */
export function ScaledFrame({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(width);
  useLayoutEffect(() => {
    if (!host) return undefined;
    const measure = () => setAvailable(host.clientWidth || width);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [host, width]);
  const scale = Math.min(1, available / width);
  return (
    <div ref={setHost} data-ds-scaled-frame={`${width}x${height}`}
      style={{ width: "100%", height: Math.round(height * scale), overflow: "hidden", borderRadius: "var(--radius-panel)", border: "var(--border-hairline) solid var(--line)" }}>
      {/* The frame is the window: blocks that size to the viewport (the new-chat stage) read its height. */}
      <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: "0 0", ["--adaptive-viewport-block-size" as string]: `${height}px` }}>
        {children}
      </div>
    </div>
  );
}
