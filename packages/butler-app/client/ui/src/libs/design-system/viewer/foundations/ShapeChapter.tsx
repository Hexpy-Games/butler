import type { CSSProperties } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { tokenCatalog } from "./catalog";
import { ChapterLayout, chapterSections, DoDont, GuideSection, ThemePanes } from "./Chapter";
import type { ChapterProps } from "./chapterProps";
import f from "./Foundations.module.css";

const tokens = (pattern: RegExp) => tokenCatalog.filter((token) => pattern.test(token.name) && !token.legacy);
const step = (name: string) => ({ "--step": `var(${name})` }) as CSSProperties;

/** The surface each radius belongs to, drawn at that surface's proportions. */
const SHAPES: Record<string, { label: string; shape: string }> = {
  "--radius-control": { label: "Buttons, fields, rows", shape: "control" },
  "--radius-panel": { label: "Cards and panels", shape: "panel" },
  "--radius-popover": { label: "Menus, popovers, dialogs", shape: "popover" },
  "--radius-composer": { label: "Composer and glass", shape: "composer" },
  "--radius-pill": { label: "Tags, switches, pills", shape: "pill" },
  "--adaptive-composer-radius": { label: "Composer on narrow screens", shape: "composer" },
};

function RadiusShapes() {
  return (
    <div className={f.shapeGrid}>
      {tokens(/^--(radius|adaptive-composer-radius)/u)
        .sort((a, b) => Object.keys(SHAPES).indexOf(a.name) - Object.keys(SHAPES).indexOf(b.name)).map((token) => {
        const meta = SHAPES[token.name] ?? { label: "Surface", shape: "panel" };
        return (
          <div className={f.shapeCell} key={token.name} data-ds-specimen={`radius-${token.name}`}>
            <div className={f.shapeStage}><span className={f.shape} data-shape={meta.shape} style={step(token.name)} /></div>
            <Stack gap="none" minWidth="0">
              <Typo.Code>{token.name}</Typo.Code>
              <Typo.Caption tone="tertiary">{`${meta.label} · ${token.light}`}</Typo.Caption>
            </Stack>
          </div>
        );
      })}
    </div>
  );
}

function NestedRadius() {
  return (
    <DoDont
      doCaption="Inner radius = outer − padding: 12px popover, 4px inset, 8px rows"
      dontCaption="Same radius inside and out pinches the corners"
      doRender={(
        <div className={f.nestOuter}>
          <span className={f.nestInner} data-active>Rename</span>
          <span className={f.nestInner}>Move to project</span>
        </div>
      )}
      dontRender={(
        <div className={f.nestOuter}>
          <span className={f.nestInner} data-active data-pinched>Rename</span>
          <span className={f.nestInner} data-pinched>Move to project</span>
        </div>
      )} />
  );
}

const LAYERS: Array<[string, string, string]> = [
  ["base", "--conversation-bg", "Page"],
  ["card", "--shadow-card", "Card"],
  ["control", "--shadow-control", "Control"],
  ["popover", "--shadow-window", "Popover and window"],
  ["drag", "--shadow-drag-lift", "Drag lift"],
];

function LayeredElevation() {
  return (
    <ThemePanes label="Elevation">
      {() => (
        <div className={f.layers}>
          {LAYERS.map(([layer, token, label], index) => (
            <div className={f.layer} data-layer={layer} key={layer} style={{ ...step(token), "--depth": index } as CSSProperties}>
              <Typo.Caption>{label}</Typo.Caption>
              <Typo.Caption tone="tertiary">{token}</Typo.Caption>
            </div>
          ))}
        </div>
      )}
    </ThemePanes>
  );
}

function ShadowTiles() {
  return (
    <ThemePanes label="Shadows">
      {() => (
        <div className={f.shadowGrid}>
          {tokenCatalog.filter((token) => token.category === "shadow").map((token) => (
            <div className={f.shadowTile} key={token.name} style={step(token.name)}>
              <Typo.Caption wrap="anywhere">{token.name}</Typo.Caption>
            </div>
          ))}
        </div>
      )}
    </ThemePanes>
  );
}

export function ShapeChapter({ chapter, anchor, locale, onOpen }: ChapterProps) {
  const s = chapterSections(chapter, [["radius", "Radius"], ["nesting", "Nesting"], ["layers", "Elevation in layers"], ["shadows", "Shadows"]]);
  return (
    <ChapterLayout anchor={anchor} chapter={chapter} locale={locale} onOpen={onOpen} sections={s.list}
      lead="Corners grow with the surface: 8px controls, 10px cards, 12px overlays, 22px for the composer. Shadows are soft, few and deeper in dark mode, where contrast comes from light, not lines.">
      <GuideSection spec={s.at("radius")} lead="Each radius on the surface it belongs to.">
        <RadiusShapes />
      </GuideSection>
      <GuideSection spec={s.at("nesting")} lead="Rows inside a rounded container follow its curve.">
        <NestedRadius />
      </GuideSection>
      <GuideSection spec={s.at("layers")} lead="Page, card, control, overlay, drag: each step up casts a longer, softer shadow.">
        <LayeredElevation />
      </GuideSection>
      <GuideSection spec={s.at("shadows")} lead="Every shadow token on a raised surface, light and dark.">
        <ShadowTiles />
      </GuideSection>
    </ChapterLayout>
  );
}
