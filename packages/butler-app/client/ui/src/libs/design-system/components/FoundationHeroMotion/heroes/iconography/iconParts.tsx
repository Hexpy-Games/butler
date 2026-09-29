import { useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { NavRow } from "../../../../blocks/NavRow";
import { SidebarNav, SidebarShell } from "../../../../blocks/SidebarShell";
import { Clock3, Folder, MessageSquare, Notebook, PencilLine, Search, Settings, type IconProps } from "../../../Icons";
import { IconSlot } from "../../../IconSlot";
import { Typo } from "../../../Typo";
import type { HeroLayout } from "../shared/grid";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { STEPS, type IconCopy } from "./iconCopy";
import { GRID_SHAPE, gridCells } from "./iconGrid";
import s from "./IconHero.module.css";

/** Every line of the 24-unit keyline grid, as one path drawn along its length. */
const GRID_PATH = Array.from({ length: 25 }, (_, k) => `M${k} 0V24M0 ${k}H24`).join("");
export const GRID_LENGTH = 25 * 48;
/** Stroke paths the gear may have (drawn one after another). */
export const GLYPH_PATHS = 4;

/** Stroke elements of a Hugeicons glyph (all its shapes are strokes). */
export const STROKES = ":is(path, circle, ellipse)";

/**
 * The gear on its 24px keyline grid at 8×: the grid, the 2px padding box and
 * the keyline circle; its three notes on three sides (top, right, bottom),
 * each at its own edge so none meets another.
 */
export function Keyline({ copy }: { copy: IconCopy }) {
  return (
    <div className={s.keyline}>
      <span className={s.keyNote} data-side="top"><R name="kl-n0">{copy.grid}</R></span>
      <div className={s.keyBox}>
        <svg className={s.keySvg} viewBox="0 0 24 24">
          <path className={s.keyGrid} d={GRID_PATH} data-t="kl-grid" style={{ "--dash": `${GRID_LENGTH}px` } as CSSProperties} />
          <path className={s.keyLine} d="M2 2H22V22H2Z" data-t="kl-pad" style={{ "--dash": "80px" } as CSSProperties} />
          <circle className={s.keyLine} cx="12" cy="12" data-t="kl-circle" r="10" style={{ "--dash": "63px" } as CSSProperties} />
        </svg>
        <span className={s.keyGlyph} data-t="kl-glyph"><Settings size={192} /></span>
      </div>
      <span className={s.keyNote} data-side="right"><R name="kl-n1">{copy.padding}</R></span>
      <span className={s.keyNote} data-side="bottom"><R name="kl-n2">{copy.stroke}</R></span>
    </div>
  );
}

/** A word in one type role. */
export function roleText(role: (typeof STEPS)[number]["role"], text: ReactNode) {
  switch (role) {
    case "caption": return <Typo.Caption>{text}</Typo.Caption>;
    case "body": return <Typo.Body>{text}</Typo.Body>;
    case "h4": return <Typo.H4 as="span">{text}</Typo.H4>;
    case "h3": return <Typo.H3 as="span">{text}</Typo.H3>;
    case "h2": return <Typo.H2 as="span">{text}</Typo.H2>;
  }
}

/** The measured size of the sidebar's icons, as its token reads. */
function IconSizeTag() {
  const ref = useRef<HTMLSpanElement>(null);
  const [px, setPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    const svg = ref.current?.closest("[data-side-frame]")?.querySelector("aside svg");
    if (svg) setPx(Math.round(svg.clientWidth || Number(svg.getAttribute("width")) || 0));
  }, []);
  return <span className={s.sideTagText} ref={ref}>{`--sidebar-icon-size ${px ?? ""}`}</span>;
}

/** A row in two real states (rest and active), crossfaded by the timeline. */
function Swap({ name, rest, on }: { name: string; rest: ReactNode; on: ReactNode }) {
  return (
    <span className={s.swap}>
      <span className={s.swapLayer} data-t={`${name}-rest`}>{rest}</span>
      <span className={s.swapLayer} data-swap="on" data-t={`${name}-on`}>{on}</span>
    </span>
  );
}

/** A sidebar glyph as the app's space rows set it: an IconSlot at the sidebar size; `k` names it for the pop-in. */
function Glyph({ Icon, k }: { Icon: ComponentType<IconProps>; k: number }) {
  return <span className={s.pop} data-t={`pl-i${k}`}><IconSlot size="sidebar"><Icon /></IconSlot></span>;
}

/**
 * The app's sidebar, as the SidebarShell showcase and the space rows build
 * it: New chat, Search and Schedules, the browse filter, conversations
 * (message, notebook and folder glyphs) and Settings in the footer, on the
 * window's sidebar surface. The first conversation is open; the timeline
 * clicks Settings (both rows swap to their other real state). The size tag
 * names the column's icon size with a leader to the first icon.
 */
export function SidebarCrop({ copy }: { copy: IconCopy }) {
  const glyphs = [MessageSquare, Notebook, MessageSquare, Folder];
  const head: Array<[string, ComponentType<IconProps>]> = [[copy.newChat, PencilLine], [copy.search, Search], [copy.schedules, Clock3]];
  const settings = (active: boolean) => <NavRow active={active} icon={<Glyph Icon={Settings} k={7} />} label={copy.settings} />;
  const first = (active: boolean) => <NavRow active={active} icon={<Glyph Icon={glyphs[0]!} k={3} />} label={copy.sessions[0]!} />;
  return (
    <div className={s.sideScene} data-mark-scope="pl" data-side-frame="">
      <span className={s.sideTag} data-t="pl-tag"><IconSizeTag /><span className={s.sideLeader} /></span>
      <div className={s.sideFrame}>
        <SidebarShell
          ariaLabel={copy.aria}
          footer={<Mark block n="set"><Swap name="pl-set" on={settings(true)} rest={settings(false)} /></Mark>}
          scrollFade={false}
          stickyHeader={<NavRow label={copy.filter} />}
          scrollHeader={<SidebarNav ariaLabel={copy.aria}>{head.map(([label, Icon], k) => <NavRow icon={<Glyph Icon={Icon} k={k} />} key={label} label={label} />)}</SidebarNav>}
        >
          <SidebarNav>
            <Mark block n="s0"><Swap name="pl-s0" on={first(true)} rest={first(false)} /></Mark>
            {copy.sessions.slice(1).map((label, k) => <NavRow icon={<Glyph Icon={glyphs[k + 1]!} k={k + 4} />} key={label} label={label} />)}
          </SidebarNav>
        </SidebarShell>
      </div>
      <svg className={s.cursor} data-t="pl-cur" viewBox="0 0 16 20" aria-hidden="true">
        <path d="M1 1 L1 16 L5 12 L8 19 L10.5 18 L7.5 11 L13 11 Z" />
      </svg>
    </div>
  );
}

/**
 * The finale: the whole DS icon set on a grid filling the frame, the gear
 * at its centre. Each glyph's strokes get a unit path length so the timeline
 * draws any glyph, one diagonal at a time (`data-d`); `data-drawn` turns the
 * dash on once the lengths are set.
 */
export function IconGrid({ layout }: { layout: HeroLayout }) {
  const ref = useRef<HTMLDivElement>(null);
  const { cols, rows, size } = GRID_SHAPE[layout];
  const cells = gridCells(layout);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    for (const stroke of grid.querySelectorAll(`[data-d] ${STROKES}`)) stroke.setAttribute("pathLength", "100");
    grid.dataset.drawn = "";
  }, [layout]);
  return (
    <div className={s.iconGrid} data-t="grid" ref={ref} style={{ "--cols": cols, "--rows": rows } as CSSProperties}>
      {cells.map(({ Glyph: Icon, d, centre }, k) => (
        <span className={s.gridCell} data-centre={centre ? "" : undefined} data-d={centre ? undefined : d} data-m={centre ? "gear" : undefined} key={k}>
          <Icon size={size} />
        </span>
      ))}
    </div>
  );
}
