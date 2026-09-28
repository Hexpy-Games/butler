import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { EmptyLine } from "../../../../blocks/EmptyLine";
import { NavRow } from "../../../../blocks/NavRow";
import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { Folder, MessageSquare, Plus, Search, Settings, Sparkles } from "../../../Icons";
import { Typo } from "../../../Typo";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { STEPS, type IconCopy } from "./iconCopy";
import s from "./IconHero.module.css";

/** Every line of the 24-unit keyline grid, as one path drawn along its length. */
const GRID_PATH = Array.from({ length: 25 }, (_, k) => `M${k} 0V24M0 ${k}H24`).join("");
export const GRID_LENGTH = 25 * 48;
/** Stroke paths the gear may have (drawn one after another). */
export const GLYPH_PATHS = 4;

/**
 * The gear on its 24px keyline grid at 8×: the grid, the 2px padding box and
 * the keyline circle; its three notes on three sides (top, right, bottom).
 * `name` prefixes the timeline's parts.
 */
export function Keyline({ copy, name }: { copy: IconCopy; name?: string }) {
  const t = (part: string) => (name ? `${name}-${part}` : undefined);
  const note = (k: number, text: string) => (name ? <R name={`${name}-n${k}`}>{text}</R> : text);
  return (
    <div className={s.keyline}>
      <span className={s.keyNote} data-side="top">{note(0, copy.grid)}</span>
      <div className={s.keyBox}>
        <svg className={s.keySvg} viewBox="0 0 24 24">
          <path className={s.keyGrid} d={GRID_PATH} data-t={t("grid")} style={{ "--dash": `${GRID_LENGTH}px` } as CSSProperties} />
          <path className={s.keyLine} d="M2 2H22V22H2Z" data-t={t("pad")} style={{ "--dash": "80px" } as CSSProperties} />
          <circle className={s.keyLine} cx="12" cy="12" data-t={t("circle")} r="10" style={{ "--dash": "63px" } as CSSProperties} />
        </svg>
        <span className={s.keyGlyph} data-t={t("glyph")}><Settings size={192} /></span>
      </div>
      <span className={s.keyNote} data-side="right">{note(1, copy.padding)}</span>
      <span className={s.keyNote} data-side="bottom">{note(2, copy.stroke)}</span>
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

/** The size ladder: the gear beside "Settings" in each role, on its own centre line. */
export function Ladder({ copy }: { copy: IconCopy }) {
  return (
    <div className={s.ladder}>
      {STEPS.map((step) => (
        <span className={s.ladderRow} key={step.role}>
          <span className={s.centreLine} />
          <span className={s.pair}><Settings size={step.icon} />{roleText(step.role, copy.settings)}</span>
          <span className={s.ladderName}>{`${step.role} · ${step.icon} ${step.px}`}</span>
        </span>
      ))}
    </div>
  );
}

/** An icon in three tones (muted, primary, accent) stacked; the timeline crossfades them. */
function Toned({ children, name }: { children: ReactNode; name?: string }) {
  return (
    <span className={s.toned}>
      {(["muted", "primary", "accent"] as const).map((tone) => <span className={s.tone} data-t={name ? `${name}-${tone}` : undefined} data-tone={tone} key={tone}>{children}</span>)}
    </span>
  );
}

/** The measured size of the first icon inside its parent, as its token reads. */
function IconSizeTag({ name }: { name?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [px, setPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    const svg = ref.current?.parentElement?.querySelector("svg");
    if (svg) setPx(Math.round(svg.clientWidth || Number(svg.getAttribute("width")) || 0));
  }, []);
  return <span className={s.sideTag} data-t={name} ref={ref}>{`--sidebar-icon-size ${px ?? ""}`}</span>;
}

/**
 * A sidebar block (real NavRows) and a toolbar of icon buttons. `name`
 * prefixes the timeline's parts: each icon pops in and takes its tone; the
 * rows are marks (a hover and a cursor walk them).
 */
export function Sidebar({ copy, name }: { copy: IconCopy; name?: string }) {
  const rows = [[copy.chats, <MessageSquare key="i" size="md" />], [copy.projects, <Folder key="i" size="md" />], [copy.files, <Search key="i" size="md" />], [copy.settings, <Settings key="i" size="md" />]] as const;
  const tools = [[copy.newChat, <Plus key="i" size="md" />], [copy.search, <Search key="i" size="md" />], [copy.settings, <Settings key="i" size="md" />], [copy.beta, <Sparkles key="i" size="md" />]] as const;
  return (
    <div className={s.sideBlock} data-mark-scope={name}>
      <div className={s.toolbar}>
        {tools.map(([label, icon], k) => <span className={s.pop} data-t={name ? `${name}-tb${k}` : undefined} key={k}><Button aria-label={label} iconStart={icon} size="icon-sm" variant="ghost" /></span>)}
      </div>
      <Box border="hairline" padding="sm" radius="panel" surface="raised">
        <div className={s.rows}>
          {rows.map(([label, icon], k) => (
            <Mark block key={k} n={`r${k}`}>
              <span className={s.rowWrap}>
                {name ? <span className={s.hover} data-t={`${name}-hv${k}`} /> : null}
                <NavRow active={!name && k === 0} icon={name ? <span className={s.pop} data-t={`${name}-i${k}`}><Toned name={`${name}-t${k}`}>{icon}</Toned></span> : icon} label={label} />
              </span>
            </Mark>
          ))}
        </div>
      </Box>
      <IconSizeTag name={name ? `${name}-tag` : undefined} />
      {name ? (
        <svg className={s.cursor} data-t={`${name}-cur`} viewBox="0 0 16 20" aria-hidden="true">
          <path d="M1 1 L1 16 L5 12 L8 19 L10.5 18 L7.5 11 L13 11 Z" />
        </svg>
      ) : null}
    </div>
  );
}

/** Finale tiles. */
export const KeyTile = ({ copy }: { copy: IconCopy }) => <div className={s.keyTile}><Keyline copy={copy} /></div>;
export const LadderTile = ({ copy }: { copy: IconCopy }) => <div className={s.ladderTile}><Ladder copy={copy} /></div>;
export const SideTile = ({ copy }: { copy: IconCopy }) => <div className={s.sideTile}><Sidebar copy={copy} /></div>;
export const EmptyTile = ({ copy }: { copy: IconCopy }) => (
  <div className={s.emptyTile}>
    <EmptyLine action={<Button size="sm" text={copy.create} variant="outline" />} icon={<Folder size="md" />} message={copy.emptyTitle} />
  </div>
);
