import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { Typo } from "../../../Typo";
import { RANGES, SCREEN, type LayoutCopy, type Mode } from "./layoutCopy";
import { DeviceFrame } from "./DeviceFrame";
import { AppScreen } from "./LayoutShell";
import s from "./LayoutHero.module.css";

/** Draws its child (a screen `w` × `h` device px) at the largest scale that fits the tile, caption below. */
function Fit({ w, h, caption, children }: { w: number; h: number; caption: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const inner = box.current;
    if (!node || !inner) return undefined;
    const fit = () => {
      const room = node.getBoundingClientRect();
      const ratio = room.width / Math.max(1, node.offsetWidth);
      const caption = 48;
      const scale = Math.min(room.width / ratio / w, (room.height / ratio - caption) / h);
      inner.style.setProperty("--fit", String(Math.max(0.05, Math.floor(scale * 1000) / 1000)));
    };
    fit();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [w, h]);
  return (
    <div className={s.fit} ref={ref}>
      <div className={s.fitBox} ref={box}>
        <div className={s.still} style={{ inlineSize: `calc(${w}px * var(--fit, 0.3))`, blockSize: `calc(${h}px * var(--fit, 0.3))` } as CSSProperties}>
          <div className={s.device} style={{ "--s": "var(--fit, 0.3)" } as CSSProperties}><DeviceFrame label={caption}>{children}</DeviceFrame></div>
        </div>
        <Typo.Caption as="span" tone="secondary">{caption}</Typo.Caption>
      </div>
    </div>
  );
}

/** A poster screen: the app in one mode at its own window size, its mode and range below. */
export function ScreenTile({ copy, mode, open }: { copy: LayoutCopy; mode: Mode; open?: boolean }) {
  return (
    <Fit caption={`${mode} · ${RANGES[mode]}`} h={SCREEN[mode].h} w={SCREEN[mode].w}>
      <AppScreen copy={copy} mode={mode} open={open} />
    </Fit>
  );
}
