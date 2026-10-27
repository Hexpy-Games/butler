import type { CSSProperties } from "react";
import { getAppCopy } from "../../../../../../../../butler-i18n/src/locale.ts";
import menu from "../../components/DropdownMenu/DropdownMenu.module.css";
import { Archive, PencilLine } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import { tokenCatalog } from "./catalog";
import { ChapterLayout, chapterSections, DoDont, GuideSection, ThemePanes } from "./Chapter";
import type { ChapterProps } from "./chapterProps";
import f from "./Foundations.module.css";

const tokens = (pattern: RegExp) => tokenCatalog.filter((token) => pattern.test(token.name) && !token.legacy);
const step = (name: string) => ({ "--step": `var(${name})` }) as CSSProperties;
/** A radius token's 100% size: `calc(8px / var(--ui-scale))` reads as 8px. */
const baseRadius = (value: string) => /^calc\((\S+) \/ var\(--ui-scale\)\)$/u.exec(value)?.[1] ?? value;

/** The surface each radius belongs to, drawn at that surface's proportions. */
const SHAPES: Record<string, { label: string; shape: string }> = {
  "--radius-control": { label: "Buttons, fields, rows", shape: "control" },
  "--radius-panel": { label: "Cards and panels", shape: "panel" },
  "--radius-popover": { label: "Menus, popovers, dialogs, column-wide cards, message bubbles and in-chat cards", shape: "popover" },
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
              <Typo.Caption tone="tertiary">{`${meta.label} · ${baseRadius(token.light)}`}</Typo.Caption>
            </Stack>
          </div>
        );
      })}
    </div>
  );
}

/** The sidebar session menu as DropdownMenu draws it (its surface and item classes), the first row hovered. */
function SessionMenu({ locale, pinched }: { locale: ChapterProps["locale"]; pinched?: boolean }) {
  const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US").sessionActions;
  return (
    <div className={cn(tintedGlassSurfaceClassName, menu.content, f.nestMenu, f.staticSpecimen)} data-glass="popover" data-radius="popover" data-slot="dropdown-menu-content">
      {([[<PencilLine size="sm" key="icon" />, copy.rename], [<Archive size="sm" key="icon" />, copy.archive]] as const).map(([icon, label], index) => (
        <div className={cn(menu.item, f.nestRow)} data-hovered={index === 0 ? "" : undefined} data-pinched={pinched ? "" : undefined}
          data-slot="dropdown-menu-item" data-variant="default" key={label}>{icon} {label}</div>
      ))}
    </div>
  );
}

function NestedRadius({ locale }: { locale: ChapterProps["locale"] }) {
  return (
    <DoDont
      doCaption="12px surface, 6px inset, 8px rows: DropdownMenu as the product draws it"
      dontCaption="Same radius inside and out pinches the corners"
      doRender={<SessionMenu locale={locale} />}
      dontRender={<SessionMenu locale={locale} pinched />} />
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
      <GuideSection spec={s.at("radius")} lead="Each radius on the surface it belongs to. Radii keep this size under Text size (큰 글자): the App zooms its whole UI by --ui-scale and every radius divides by it, so write a px radius as calc(6px / var(--ui-scale)).">
        <RadiusShapes />
      </GuideSection>
      <GuideSection spec={s.at("nesting")} lead="A menu keeps --radius-popover (12px) on its surface and --radius-control (8px) on its rows, so a row matches every other control. The inset only sets the gap: 6px in DropdownMenu and ContextMenu, --space-1 (4px) for OptionMenu in a Popover. A column-wide Card (radius lg, 12px) works the same way: a frame directly inside follows the card's corners and its buttons keep 8px.">
        <NestedRadius locale={locale} />
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
