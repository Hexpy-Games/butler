import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { Tag } from "../../../Tag";
import { Typo } from "../../../Typo";
import { Reveal as R } from "../shared/Reveal";
import { MODES, RANGES, SCREEN, tokenValue, type LayoutCopy, type Mode } from "./layoutCopy";
import { DeviceFrame } from "./DeviceFrame";
import { AppScreen } from "./LayoutShell";
import s from "./LayoutHero.module.css";

/** The measures on the window's rim: [part, axis, token, value]. */
function measures(): Array<[part: string, axis: "v" | "h", label: string]> {
  const value = (token: string) => `${token} · ${tokenValue(token).replace(/px$/u, "")}`;
  return [
    ["bar", "v", value("--titlebar-height")],
    ["bar-compact", "v", "--titlebar-height · 56"],
    ["side", "h", value("--sidebar-width")],
    ["read", "h", value("--page-max-width-reading")],
    ["read-medium", "h", value("--page-max-width-reading")],
    ["drawer", "h", "--adaptive-drawer-width · 100vw"],
  ];
}

/** The window's width in device px, read from the window itself on every frame of the drag: one tabular number that changes in place. */
function LiveWidth() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const win = node?.closest("[data-slot=\"foundation-hero\"]")?.querySelector<HTMLElement>("[data-t=\"win\"]");
    if (!node || !win) return undefined;
    const show = () => {
      // The window's box is drawn at --s canvas px per device px (LayoutHero.module.css).
      const scale = Number.parseFloat(getComputedStyle(win.parentElement!).getPropertyValue("--s")) || 1;
      node.textContent = String(Math.round(win.offsetWidth / scale));
    };
    show();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(show) : null;
    observer?.observe(win);
    return () => observer?.disconnect();
  }, []);
  return <span className={s.liveWidth} ref={ref}>1280</span>;
}

/** The width and mode as the handle drags: the width follows the window, the mode cuts at each breakpoint. */
function Readout({ id, className }: { id: string; className: string }) {
  return (
    <span className={className} data-t={id}>
      <Tag tone="accent"><LiveWidth /> px</Tag>
      <span className={s.modes}>{MODES.map((mode, k) => <span data-t={`${id}-m${k}`} key={mode}><Tag>{mode}</Tag></span>)}</span>
    </span>
  );
}

/**
 * The window scene: Butler's app shell in a window, one layer per mode
 * (each the real AdaptiveShell composition, reflowing live as the window's
 * width animates), its measures on the rim beside the edge each belongs to,
 * the handle on the right edge and the width and mode above it.
 */
export function WindowScene({ copy }: { copy: LayoutCopy }) {
  return (
    <div className={s.stage} data-m="stage">
      <div className={s.win} data-m="win" data-t="win">
        <div className={s.device} data-t="dev">
          {MODES.map((mode) => (
            <div className={s.layer} data-t={`ly-${mode}`} key={mode}>
              <DeviceFrame label={mode}><AppScreen copy={copy} mode={mode} open={mode === "expanded"} /></DeviceFrame>
            </div>
          ))}
          {/* Compact's drawer, open: it slides in over the whole width, the conversation staying where it is under it. */}
          <div className={s.layer} data-t="ly-drawer">
            <DeviceFrame label="drawer"><AppScreen copy={copy} mode="compact" open /></DeviceFrame>
          </div>
        </div>
      </div>
      <div className={s.rim} data-t="rim">
        {measures().map(([part, axis, label]) => (
          <span key={part}>
            <span className={s.dim} data-axis={axis} data-part={part} data-t={`dm-${part}`} />
            <span className={s.tag} data-part={part} data-t={`tg-${part}`}><Tag><R name={`tl-${part}`}>{label}</R></Tag></span>
          </span>
        ))}
        <span className={s.leader} data-t="ld-bar" />
        <span className={s.handle} data-t="handle" />
        <Readout className={s.readout} id="ro" />
      </div>
    </div>
  );
}

/** Tall canvas: the width and mode in the frame's corner, whatever the camera's zoom. */
export const Hud = () => <Readout className={s.hud} id="hu" />;

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

/** responsive.ts on a width ruler: compact to compactMax 640, medium to mediumMax 1023, expanded above. */
export function Ruler() {
  const order: Mode[] = ["compact", "medium", "expanded"];
  return (
    <div className={s.ruler}>
      {order.map((mode) => (
        <span className={s.span} key={mode}>
          <Typo.Label as="span">{mode}</Typo.Label>
          <span className={s.spanRange}>{RANGES[mode]}</span>
        </span>
      ))}
    </div>
  );
}
