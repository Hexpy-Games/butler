import type { CSSProperties } from "react";
import { Notice } from "../../blocks/Notice";
import { Stack } from "../../components/Stack";
import { TintedGlass } from "../../components/TintedGlass";
import { Typo } from "../../components/Typo";
import { tokenCatalog } from "./catalog";
import { ChapterLayout, chapterSections, GuideSection, ThemePanes } from "./Chapter";
import type { ChapterProps } from "./chapterProps";
import { PaletteBands, RolesOnSurfaces, SemanticMap } from "./ColorSpecimens";
import f from "./Foundations.module.css";

const vars = (entries: Record<string, string>) =>
  Object.fromEntries(Object.entries(entries).map(([key, token]) => [key, `var(${token})`])) as CSSProperties;

/** A window drawn from the app surface tokens, each layer labelled. */
function SurfaceStack() {
  return (
    <ThemePanes label="App surfaces">
      {() => (
        <div className={f.surfaceWindow}>
          <div className={f.surfaceSidebar}><Typo.Caption tone="secondary">--sidebar-bg</Typo.Caption></div>
          <div className={f.surfaceMain}>
            <Typo.Caption tone="secondary">--conversation-bg</Typo.Caption>
            <div className={f.surfaceBubble}><Typo.Caption>--user-message-bg</Typo.Caption></div>
            <div className={f.surfaceCard}>
              <Typo.Caption>--surface-raised · --shadow-card</Typo.Caption>
              <div className={f.surfaceControl}><Typo.Caption tone="secondary">--control-bg</Typo.Caption></div>
            </div>
            <div className={f.surfaceOverlay}><Typo.Caption>--color-surface-overlay</Typo.Caption></div>
          </div>
        </div>
      )}
    </ThemePanes>
  );
}

function StatusSet() {
  return (
    <ThemePanes label="Status">
      {() => (
        <Stack gap="sm">
          <Notice tone="success" title="Saved" message="--color-success-bg · -border · -text" />
          <Notice tone="warning" title="Needs attention" message="--color-warning-bg · -border · -text" />
          <Notice tone="error" title="Request failed" message="--color-danger-bg · -border · -text" />
          <Notice tone="info" title="Heads up" message="--color-info-bg · -border · -text" />
        </Stack>
      )}
    </ThemePanes>
  );
}

const SYNTAX: Array<[string, string]> = [
  ["--syntax-comment", "// Ask, then act\n"], ["--syntax-keyword", "const "], ["--syntax-variable", "reply"], ["", ": "],
  ["--syntax-type", "Reply"], ["", " = "], ["--syntax-keyword", "await "], ["--syntax-title", "butler.ask"], ["", "("],
  ["--syntax-string", "\"요약해 줘\""], ["", ", { tokens: "], ["--syntax-number", "4096"], ["", " });\n"],
  ["--syntax-meta", "@release "], ["--syntax-addition", "+ focus ring "], ["--syntax-deletion", "- outline: none"],
];

function ChartAndSyntax() {
  const chart = tokenCatalog.filter((token) => token.group === "Chart" && /^--context-chart-/u.test(token.name));
  return (
    <ThemePanes label="Chart and syntax">
      {() => (
        <Stack gap="md">
          <div className={f.chartBar} aria-hidden="true">
            {chart.map((token, index) => <span key={token.name} style={{ ...vars({ "--swatch": token.name }), flexGrow: chart.length - index }} />)}
          </div>
          <Typo.Caption tone="tertiary">{`${chart.map((token) => token.name.replace("--context-chart-", "")).join(" · ")} · --context-chart-*`}</Typo.Caption>
          <pre className={f.syntax}>
            {SYNTAX.map(([token, text], index) => <span key={index} style={token ? vars({ color: token }) : undefined}>{text}</span>)}
          </pre>
        </Stack>
      )}
    </ThemePanes>
  );
}

function GlassOverPalette() {
  return (
    <ThemePanes label="Glass">
      {() => (
        <div className={f.glassStage}>
          <div className={f.glassStripes} aria-hidden="true" />
          <TintedGlass radius="composer" padding="lg">
            <Stack gap="xs">
              <Typo.PanelTitle>Tinted glass</Typo.PanelTitle>
              <Typo.Caption tone="secondary">--tinted-glass-bg, -border, -highlight over live content</Typo.Caption>
            </Stack>
          </TintedGlass>
        </div>
      )}
    </ThemePanes>
  );
}

export function ColorChapter({ chapter, anchor, locale, onOpen }: ChapterProps) {
  const s = chapterSections(chapter, [
    ["palette", "Palette"], ["roles", "Roles on surfaces"], ["surfaces", "Surfaces"], ["status", "Status"],
    ["semantic-map", "Semantic map"], ["data-and-code", "Charts and code"], ["glass", "Glass"],
  ]);
  return (
    <ChapterLayout anchor={anchor} chapter={chapter} locale={locale} onOpen={onOpen} sections={s.list}
      lead="Neutrals carry the interface; blue marks the one action that matters; green, amber and red speak only for status. Product code uses role tokens. Palette steps only feed them.">
      <GuideSection spec={s.at("palette")} lead="Ten-step ramps and twelve greys. Steps are raw material, never used directly in product CSS.">
        <PaletteBands />
      </GuideSection>
      <GuideSection spec={s.at("roles")} lead="Each role on the surface it is used on, light and dark. Ratios are measured from the rendered colors; body text needs AA (4.5:1).">
        <RolesOnSurfaces />
      </GuideSection>
      <GuideSection spec={s.at("surfaces")} lead="Translucent layers over the desktop: sidebar, conversation, raised cards, controls and overlays.">
        <SurfaceStack />
      </GuideSection>
      <GuideSection spec={s.at("status")} lead="Status speaks through a tinted background, a border and a text color, always together, always with words.">
        <StatusSet />
      </GuideSection>
      <GuideSection spec={s.at("semantic-map")} lead="Which palette step each role resolves to in light and dark.">
        <SemanticMap />
      </GuideSection>
      <GuideSection spec={s.at("data-and-code")} lead="Chart series reuse the role colors; syntax colors are tuned per theme.">
        <ChartAndSyntax />
      </GuideSection>
      <GuideSection spec={s.at("glass")} lead="Glass is tint, border and highlight tokens; it stays readable over moving content.">
        <GlassOverPalette />
      </GuideSection>
    </ChapterLayout>
  );
}
