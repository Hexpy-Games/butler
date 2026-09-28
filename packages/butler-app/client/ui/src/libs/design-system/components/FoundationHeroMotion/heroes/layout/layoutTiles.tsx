import type { CSSProperties } from "react";
import { NavRow } from "../../../../blocks/NavRow";
import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { Folder, MessageSquare, PanelLeft, Search } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import { MODES, WIDTHS, type LayoutCopy } from "./layoutCopy";
import s from "./LayoutHero.module.css";

function Nav({ copy }: { copy: LayoutCopy }) {
  const rows = [[copy.chats, <MessageSquare key="i" size="sm" />], [copy.projects, <Folder key="i" size="sm" />], [copy.files, <Search key="i" size="sm" />]] as const;
  return <div className={s.nav}>{rows.map(([label, icon], k) => <NavRow active={k === 0} icon={icon} key={label} label={label} />)}</div>;
}

/**
 * The shell as it lays out at one of the widths (device px; the page draws
 * it at `--z`): titlebar, sidebar (expanded and medium), the card grid in
 * its mode's columns; compact folds the sidebar into a menu button. `name`
 * prefixes the timeline's parts; the first width carries the frame's part
 * bands, the last the drawer and the device insets.
 */
export function Shell({ copy, k, name }: { copy: LayoutCopy; k: number; name?: string }) {
  const width = WIDTHS[k]!;
  const compact = width.mode === "compact";
  const t = (part: string) => (name ? `${name}-${part}` : undefined);
  return (
    <div className={s.shell} data-t={name} style={{ "--device": `${width.px}px`, "--cols": width.columns } as CSSProperties}>
      <div className={s.bar} data-t={t("bar")}>
        <TitlebarShell leading={compact ? <Button aria-label={copy.menu} iconStart={<PanelLeft size="md" />} size="icon-sm" variant="ghost" /> : undefined} title={copy.app} />
      </div>
      <div className={s.body} data-compact={compact ? "" : undefined}>
        {compact ? null : <div className={s.side} data-t={t("side")}><Nav copy={copy} /></div>}
        <div className={s.main}>
          <div className={s.cards}>
            {copy.cards.map((card, n) => (
              <div data-t={t(`c${n}`)} key={card}>
                <Box border="hairline" padding="md" radius="panel" surface="raised">
                  <Stack gap="xs">
                    <Typo.PanelTitle>{card}</Typo.PanelTitle>
                    <Typo.Caption>{copy.notes[n]}</Typo.Caption>
                  </Stack>
                </Box>
              </div>
            ))}
          </div>
        </div>
      </div>
      {name && k === 0 ? (["bar", "side", "gutter"] as const).map((part) => <span className={s.partBand} data-part={part} data-t={t(`pb-${part}`)} key={part} />) : null}
      {name && k === WIDTHS.length - 1 ? (
        <>
          <span className={s.scrim} data-t={t("scrim")} />
          <div className={s.drawer} data-t={t("drawer")}><Nav copy={copy} /></div>
          <span className={s.inset} data-side="top" data-t={t("it")} />
          <span className={s.inset} data-side="bottom" data-t={t("ib")} />
        </>
      ) : null}
    </div>
  );
}

/** The three modes and where each begins (responsive.ts). */
export function ModeStrip() {
  const ranges = ["≥ 1024", "641–1023", "≤ 640"];
  return (
    <div className={s.modeStrip}>
      {MODES.map((mode, k) => (
        <span className={s.modeCell} key={mode}>
          <span className={s.modeName}>{mode}</span>
          <span className={s.modeRange}>{ranges[k]}</span>
        </span>
      ))}
    </div>
  );
}

/** A width's shell as a still frame. */
const Still = ({ copy, k }: { copy: LayoutCopy; k: number }) => (
  <div className={s.still} data-k={k}>
    <Shell copy={copy} k={k} />
  </div>
);

/** Finale tiles. */
export const ExpandedTile = ({ copy }: { copy: LayoutCopy }) => <Still copy={copy} k={0} />;
export const MediumTile = ({ copy }: { copy: LayoutCopy }) => <Still copy={copy} k={1} />;
export const PhoneTile = ({ copy }: { copy: LayoutCopy }) => <Still copy={copy} k={3} />;
export const ModesTile = () => <ModeStrip />;
