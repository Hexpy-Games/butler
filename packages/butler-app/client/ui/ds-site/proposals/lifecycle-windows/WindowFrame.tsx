import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Stack, Typo } from "@/butler-ds";
import { STAGE_MESSAGE, WINDOW_SIZE, stateToQuery, type LifecycleKind, type LifecycleState } from "./state";

function useAvailableWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The window at its real size (1 CSS px = 1 pt), in a same-origin frame so `100dvh` and the wallpaper
 * resolve against the window, not the page. Scaled down only when the page is narrower than the window.
 */
export function WindowFrame({ kind, state, title, playSignal }: { kind: LifecycleKind; state: LifecycleState; title: string; playSignal: number }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [measureRef, available] = useAvailableWidth();
  const size = WINDOW_SIZE[state.variant];
  // Loaded once; later changes are posted in so the mark and the wallpaper keep their state.
  const src = useMemo(() => `?${new URLSearchParams({ proposal: "lifecycle-windows", stage: kind, ...stateToQuery(state) })}`, [kind]);
  const post = (data: object) => frameRef.current?.contentWindow?.postMessage({ type: STAGE_MESSAGE, ...data }, location.origin);

  useEffect(() => { post({ state }); }, [state]);
  useEffect(() => { if (playSignal) post({ play: true }); }, [playSignal]);

  const scale = available > 0 ? Math.min(1, available / size.width) : 1;
  return (
    <Stack gap="sm" grow basis="0" minWidth="0">
      <Typo.Caption tone="secondary">{`${title} · ${size.width}×${size.height}${scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}`}</Typo.Caption>
      <div ref={measureRef}>
        <Stack gap="none" UNSAFE_style={{ width: size.width * scale, height: size.height * scale }}>
          <Box border="hairline" radius="panel" surface="none">
            <Stack gap="none" UNSAFE_style={{ width: size.width * scale, height: size.height * scale }}>
              <Stack gap="none" UNSAFE_style={{
                width: size.width, height: size.height,
                transform: `translate(${(size.width * (scale - 1)) / 2}px, ${(size.height * (scale - 1)) / 2}px) scale(${scale})`,
              }}>
                <iframe ref={frameRef} title={title} src={src} width={size.width} height={size.height} frameBorder={0}
                  onLoad={() => post({ state })} />
              </Stack>
            </Stack>
          </Box>
        </Stack>
      </div>
    </Stack>
  );
}
