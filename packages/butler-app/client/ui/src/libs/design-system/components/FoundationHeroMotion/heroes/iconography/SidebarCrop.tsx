import { useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { NavRow } from "../../../../blocks/NavRow";
import { SidebarNav, SidebarShell } from "../../../../blocks/SidebarShell";
import { Clock3, Folder, MessageSquare, Notebook, PencilLine, Search, Settings, type IconProps } from "../../../Icons";
import { IconSlot } from "../../../IconSlot";
import { Mark } from "../shared/Mark";
import { type IconCopy } from "./iconCopy";
import s from "./IconHero.module.css";

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
