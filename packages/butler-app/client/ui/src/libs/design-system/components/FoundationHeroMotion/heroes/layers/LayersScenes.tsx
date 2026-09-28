import type { CSSProperties, ReactNode } from "react";
import { ListRow } from "../../../../blocks/ListRow";
import { NavRow } from "../../../../blocks/NavRow";
import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import tip from "../../../../shadcn/ui/tooltip.module.css";
import { Box } from "../../../Box";
import { FieldLabel } from "../../../Field";
import { IconButton } from "../../../IconButton";
import { FileText, Folder, MessageSquare, Search, Settings } from "../../../Icons";
import { SelectButton } from "../../../Select";
import { Stack } from "../../../Stack";
import { tintedGlassSurfaceClassName } from "../../../TintedGlass";
import { Typo } from "../../../Typo";
import { GAP, SHEETS, zValue, type LayersCopy, type Sheet } from "./layersCopy";
import s from "./LayersHero.module.css";

/** The title's touch: three offset copies of the word, merging into one. */
export function TitleCopies({ title }: { title: string }) {
  return (
    <span className={s.titleStack}>
      <span className={s.titleCopy} data-k="2" data-t="tc-2">{title}</span>
      <span className={s.titleCopy} data-k="1" data-t="tc-1">{title}</span>
      <span>{title}</span>
    </span>
  );
}

const Card = ({ copy }: { copy: LayersCopy }) => (
  <Box border="hairline" padding="md" radius="panel" surface="raised"><Typo.Label as="span">{copy.plan}</Typo.Label></Box>
);

/** What each sheet carries, placed where it sits on the screen. */
function content(sheet: Sheet, copy: LayersCopy, live: boolean): ReactNode {
  switch (sheet) {
    case "page": return (
      <div className={s.page}>
        <div className={s.list}>{[copy.weekly, copy.notes, copy.inbox].map((title) => <ListRow icon={<FileText size="md" />} key={title} meta={copy.today} title={title} />)}</div>
        <span className={s.pageCard} data-t={live ? "page-card" : undefined}><Card copy={copy} /></span>
      </div>
    );
    case "sticky": return <div className={s.bar}><TitlebarShell title={copy.app} trailing={<IconButton label={copy.settings}><Settings size="md" /></IconButton>} /></div>;
    case "drawer": return (
      <div className={s.drawer}>
        <NavRow active icon={<MessageSquare size="sm" />} label={copy.chats} />
        <NavRow icon={<Folder size="sm" />} label={copy.projects} />
        <NavRow icon={<Search size="sm" />} label={copy.files} />
      </div>
    );
    case "overlay": return <span className={s.scrim} />;
    case "dialog": return (
      <div className={s.dialog}>
        <Box border="hairline" padding="lg" radius="popover" surface="overlay">
          <Stack gap="md">
            <Typo.H5 as="span">{copy.dialogTitle}</Typo.H5>
            <Stack gap="xs"><FieldLabel>{copy.project}</FieldLabel><SelectButton>{copy.pick}</SelectButton></Stack>
          </Stack>
        </Box>
      </div>
    );
    case "popover": return (
      <div className={s.menu}>
        <Box border="hairline" padding="xs" radius="popover" surface="overlay">
          {[copy.pick, copy.other].map((item, k) => <div className={s.option} data-on={k === 0 ? "" : undefined} key={item}><Typo.Body>{item}</Typo.Body></div>)}
        </Box>
      </div>
    );
    case "tooltip": return <span className={s.tip}><span className={`${tintedGlassSurfaceClassName} ${tip.tooltip}`}>{copy.tip}</span></span>;
    case "drag": return <span className={s.dragCard} data-t={live ? "drag-card" : undefined}><Card copy={copy} /></span>;
  }
}

/**
 * The screen as a stack of sheets: each layer on its own full-size sheet
 * (content where it sits on the screen), a glass rim and its z token at its
 * left edge (shown once exploded). Flat, it is one screen; exploded along z
 * in a quarter view, the sheets read as the named layers. Live in the scene
 * (keyed by the timeline), exploded and still in the poster.
 */
export function Screen({ copy, live, exploded = false }: { copy: LayersCopy; live: boolean; exploded?: boolean }) {
  const t = (name: string) => (live ? name : undefined);
  return (
    <div className={s.screen} data-exploded={exploded ? "" : undefined} data-m={live ? "screen" : undefined}>
      {SHEETS.map((sheet, k) => (
        <div className={s.sheet} data-sheet={sheet} data-t={t(`sh-${k}`)} key={sheet} style={{ "--z": `${k * GAP}px` } as CSSProperties}>
          <span className={s.glass} data-t={t(`gl-${k}`)} />
          {content(sheet, copy, live)}
          <span className={s.label} data-t={t(`lb-${k}`)}>{sheet === "page" ? "page · 0" : `--z-${sheet} · ${zValue(sheet)}`}</span>
          {sheet === "popover" ? <span className={s.flash} data-t={t("flash")} /> : null}
        </div>
      ))}
    </div>
  );
}

/** Finale: the z ladder, low to high, like floor numbers. */
export function Ladder() {
  return (
    <div className={s.ladder}>
      {[...SHEETS].reverse().filter((sheet) => sheet !== "page").map((sheet) => (
        <span className={s.rung} key={sheet}><span className={s.rungName}>{`--z-${sheet}`}</span><span className={s.rungValue}>{zValue(sheet)}</span></span>
      ))}
    </div>
  );
}
