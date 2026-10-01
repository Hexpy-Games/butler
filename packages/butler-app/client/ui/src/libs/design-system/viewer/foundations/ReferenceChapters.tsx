import { useEffect, useRef, type CSSProperties } from "react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { ICON_SIZE, Search, Settings, Sparkles, type IconSize } from "../../components/Icons";
import { Input } from "../../components/Input";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Stack } from "../../components/Stack";
import { Switch } from "../../components/Switch";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { markForceTargets } from "../states/forceState";
import { useForceStateLayer } from "../states/StatesMatrix";
import { tokenCatalog } from "./catalog";
import { ChapterLayout, chapterSections, DoDont, GuideSection, Specimen, ThemePanes } from "./Chapter";
import type { ChapterProps } from "./chapterProps";
import { useTokenPx, WidthBars } from "./Measures";
import f from "./Foundations.module.css";

const tokens = (pattern: RegExp) => tokenCatalog.filter((token) => pattern.test(token.name) && !token.legacy);

/* ---- 06 Iconography ---- */

const ICON_PAIRING: Record<string, string> = {
  xs: "Inside tags and chips", sm: "Compact rows, captions", md: "Controls and body rows", lg: "Touch rows, panel headers",
  xl: "Empty states, large toggles", "2xl": "Marks and illustrations",
};

function IconRamp() {
  const icons = tokens(/^--icon-size-/u);
  const [values, probes] = useTokenPx(icons.map((token) => token.name));
  return (
    <div className={f.iconRamp}>
      {probes}
      {icons.map((token) => {
        const size = token.name.replace("--icon-size-", "") as IconSize;
        const inSync = values[token.name] === undefined || ICON_SIZE[size] === values[token.name];
        return (
          <div className={f.iconCell} key={token.name} data-ds-specimen={`icon-${size}`}>
            <span className={f.iconStage}><span className={f.iconFrame} style={{ "--step": `var(${token.name})` } as CSSProperties}><Sparkles size={size} /></span></span>
            <Stack gap="none" cross="center">
              <Typo.Label as="span">{`size="${size}"`}</Typo.Label>
              <Typo.Caption tone="tertiary" numeric="tabular">{`${token.light} · ${token.name}`}</Typo.Caption>
              <Typo.Caption tone="secondary" align="center">{ICON_PAIRING[size] ?? ""}</Typo.Caption>
              {inSync ? null : <Tag tone="warning">{`ICON_SIZE ${ICON_SIZE[size]}px`}</Tag>}
            </Stack>
          </div>
        );
      })}
    </div>
  );
}

function IconWithType() {
  return (
    <DoDont
      doCaption="One icon size per row, matched to the text beside it"
      dontCaption="Mixed sizes in one row break the baseline"
      doRender={(
        <Stack gap="sm">
          <Stack align="row" cross="center" gap="xs"><Search size="sm" /><Typo.Caption>Search · sm with Caption</Typo.Caption></Stack>
          <Stack align="row" cross="center" gap="sm"><Settings size="md" /><Typo.Body>Settings · md with Body</Typo.Body></Stack>
          <Stack align="row" cross="center" gap="sm"><Sparkles size="lg" /><Typo.H4 as="span">Butler · lg with H4</Typo.H4></Stack>
        </Stack>
      )}
      dontRender={(
        <Stack align="row" cross="center" gap="xs"><Search size="xl" /><Typo.Caption>Search</Typo.Caption><Settings size="xs" /><Typo.Body>Settings</Typo.Body></Stack>
      )} />
  );
}

export function IconographyChapter({ chapter, anchor, locale, onOpen }: ChapterProps) {
  const s = chapterSections(chapter, [["sizes", "Sizes"], ["pairing", "Icons with text"]]);
  return (
    <ChapterLayout anchor={anchor} chapter={chapter} locale={locale} onOpen={onOpen} sections={s.list}
      lead="Hugeicons stroke glyphs at six named sizes. Icons label; they rarely stand alone, and an icon-only control always carries an accessible name."
      headerExtra={<Button size="xs" variant="borderless" text="Browse the icon set" onClick={() => onOpen("icons")} />}>
      <GuideSection spec={s.at("sizes")} lead="Pass the size name, never pixels. The frame is the token; the glyph is the component.">
        <IconRamp />
      </GuideSection>
      <GuideSection spec={s.at("pairing")} lead="Icon size follows the type role of its row.">
        <IconWithType />
      </GuideSection>
    </ChapterLayout>
  );
}

/* ---- 07 Focus ring ---- */

/** Real controls with :focus-visible forced (the states matrix layer). */
function FocusedControls() {
  useForceStateLayer();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (root.current) markForceTargets(root.current); });
  return (
    <div ref={root}>
      <ThemePanes label="Focus ring">
        {() => (
          <div className={f.focusGrid}>
            <div className={f.focusCell} data-ds-force-state="focus-visible"><Button text="Continue" /></div>
            <div className={f.focusCell} data-ds-force-state="focus-visible"><IconButton label="Settings"><Settings size="md" /></IconButton></div>
            <div className={f.focusCell} data-ds-force-state="focus-visible"><Input aria-label="Name" defaultValue="Butler" /></div>
            <div className={f.focusCell} data-ds-force-state="focus-visible"><Switch aria-label="Sidebar" defaultChecked /></div>
            <div className={f.focusCell} data-ds-force-state="focus-visible">
              <SegmentedControl ariaLabel="Theme" size="sm" value="light" onValueChange={() => undefined}
                options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
            </div>
          </div>
        )}
      </ThemePanes>
    </div>
  );
}

export function FocusChapter({ chapter, anchor, locale, onOpen }: ChapterProps) {
  const s = chapterSections(chapter, [["ring", "The ring"], ["controls", "On every control"], ["rules", "Rules"]]);
  return (
    <ChapterLayout anchor={anchor} chapter={chapter} locale={locale} onOpen={onOpen} sections={s.list}
      lead="A 2px accent ring, drawn as a box-shadow so it follows the control's radius. It appears for the keyboard (:focus-visible), not for the mouse.">
      <GuideSection spec={s.at("ring")} lead="--focus-ring = 0 0 0 --focus-ring-width --focus-ring-color. Shape-specific indicators may use a bottom line (underline Input), retaining the 2px focus token thickness and at least 3:1 contrast against adjacent surfaces. Reserve space inside clipping containers.">
        <div className={f.ringSpec}>
          <span className={f.ringSample} aria-hidden="true" />
          <Stack gap="xs" minWidth="0">
            {tokens(/^--focus-ring/u).map((token) => (
              <Stack align="row" cross="baseline" gap="sm" key={token.name} wrap>
                <Typo.Code>{token.name}</Typo.Code>
                <Typo.Caption tone="tertiary" wrap="anywhere">{token.light}</Typo.Caption>
              </Stack>
            ))}
          </Stack>
        </div>
      </GuideSection>
      <GuideSection spec={s.at("controls")} lead="Focus forced on real DS controls, light and dark.">
        <FocusedControls />
      </GuideSection>
      <GuideSection spec={s.at("rules")} lead="The ring is part of the control; keep room for it.">
        <DoDont
          doCaption="Give the ring room: a padded container keeps all 2px visible"
          dontCaption="A clipping parent cuts the ring (overflow: hidden, no inset)"
          doRender={<div className={f.ringRoom}><span className={f.ringSample} aria-hidden="true" /></div>}
          dontRender={<div className={f.ringClip}><span className={f.ringSample} aria-hidden="true" /></div>} />
      </GuideSection>
    </ChapterLayout>
  );
}

/* ---- 09 Layers ---- */

function LayerStack() {
  const layers = tokens(/^--z-/u).map((token) => ({ token, value: Number(token.light) })).sort((a, b) => a.value - b.value);
  return (
    <div className={f.zStack} data-ds-specimen="z-stack">
      {layers.map(({ token, value }, index) => (
        <div className={f.zPlane} key={token.name} style={{ "--depth": index } as CSSProperties}>
          <Typo.Label as="span" numeric="tabular">{value}</Typo.Label>
          <Typo.Code>{token.name}</Typo.Code>
        </div>
      ))}
    </div>
  );
}

export function LayersChapter({ chapter, anchor, locale, onOpen }: ChapterProps) {
  const s = chapterSections(chapter, [["order", "Stacking order"]]);
  return (
    <ChapterLayout anchor={anchor} chapter={chapter} locale={locale} onOpen={onOpen} sections={s.list}
      lead="Nine named layers, lowest first. Overlays opened inside a dialog portal above it; nothing else sets a z-index.">
      <GuideSection spec={s.at("order")} lead="Sorted by value from tokens.css.">
        <LayerStack />
      </GuideSection>
    </ChapterLayout>
  );
}

/* ---- 10 Layout and platform ---- */

function SafeAreas() {
  return (
    <Specimen caption="env(safe-area-inset-*) with a 0px fallback; the shell pads its chrome by these">
      <div className={f.safeFrame}>
        {["top", "right", "bottom", "left"].map((side) => <span className={f.safeEdge} data-side={side} key={side}><Typo.Caption>{`--safe-area-${side}`}</Typo.Caption></span>)}
        <span className={f.safeBody}><Typo.Caption tone="tertiary">content</Typo.Caption></span>
      </div>
    </Specimen>
  );
}

export function LayoutChapter({ chapter, anchor, locale, onOpen }: ChapterProps) {
  const s = chapterSections(chapter, [["safe-areas", "Safe areas"], ["dialogs", "Dialog widths"], ["geometry", "Component geometry"]]);
  return (
    <ChapterLayout anchor={anchor} chapter={chapter} locale={locale} onOpen={onOpen} sections={s.list}
      lead="Values the shell and a few components read: platform insets, dialog widths and fixed heights for charts, lanes and scroll areas.">
      <GuideSection spec={s.at("safe-areas")} lead="Notches, home indicators and the on-screen keyboard.">
        <SafeAreas />
      </GuideSection>
      <GuideSection spec={s.at("dialogs")} lead="Four dialog widths, scaled against the widest.">
        <WidthBars tokens={tokens(/^--dialog-width-/u)} />
      </GuideSection>
      <GuideSection spec={s.at("geometry")} lead="Heights and widths owned by one component each.">
        <WidthBars tokens={tokens(/^--(chart-height-|kanban-lane-|split-browser-height|scroll-area-|skeleton-height-)/u)} />
      </GuideSection>
    </ChapterLayout>
  );
}
