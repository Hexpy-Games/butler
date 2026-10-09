import type { CSSProperties } from "react";
import { SettingsField } from "../../blocks/SettingsField";
import { SettingsPage, SettingsSection } from "../../blocks/SettingsSection";
import { Button } from "../../components/Button";
import { Stack, type StackGap } from "../../components/Stack";
import { Switch } from "../../components/Switch";
import { Typo } from "../../components/Typo";
import { tokenCatalog } from "./catalog";
import { ChapterLayout, chapterSections, GuideSection, Specimen } from "./Chapter";
import type { ChapterProps } from "./chapterProps";
import { Staircase, useTokenPx, WidthBars } from "./Measures";
import f from "./Foundations.module.css";

const tokens = (pattern: RegExp) => tokenCatalog.filter((token) => pattern.test(token.name) && !token.legacy);

const GAPS: StackGap[] = ["xs", "sm", "md", "lg", "xl", "2xl"];

/** Where two surfaces meet, exactly one side draws the hairline. */
const EDGE_RULES = [
  "Side by side, the surface that follows draws its leading hairline: the workspace beside the sidebar, the browser pane beside the chat, the inspector beside the workspace. The other side draws none.",
  "Stacked, the lower surface draws its top hairline (the pane under the title bar); a title bar draws no bottom line.",
  "At the window edge the window frame (the workspace border) draws the line; a surface reaching it tucks its own border under the frame instead of doubling it, and leaves no strip.",
  "A surface nested inside another (the page card in the pane) draws no parallel hairline: its elevation sets it apart. State edges (Butler's riso edge, your tab, an approval) are not structure and may draw.",
  "A resize handle draws no line of its own: the divider is the surfaces' hairline; the handle adds the grabber.",
  "In the cards frame (AdaptiveShell frame=\"cards\") no two surfaces share an edge: each card (conversation, browser sheet, inspector, settings detail) draws one quiet --shell-card-edge of its own, 8px off the window and off the next card; the gap is the resize handle's lane. The page card inside the sheet still draws none.",
];

/** Stack gaps made visible: the hatch is the gap. */
function GapsInUse() {
  return (
    <div className={f.gapGrid}>
      {GAPS.map((gap) => (
        <Specimen caption={`gap="${gap}" · --space-${gap}`} key={gap}>
          <div className={f.hatch}>
            <Stack align="row" gap={gap}>
              {[1, 2, 3].map((item) => <span className={f.tile} key={item} />)}
            </Stack>
          </div>
        </Specimen>
      ))}
    </div>
  );
}

/** A card with its padding and gaps hatched and named. */
function CardAnatomy() {
  return (
    <div className={f.anatomy}>
      <div className={f.anatomyCard}>
        <Stack gap="sm">
          <div className={f.anatomyFill}><Typo.PanelTitle>Worker activity</Typo.PanelTitle></div>
          <div className={f.anatomyFill}><Typo.Body tone="secondary">Three workers finished; one is waiting for approval.</Typo.Body></div>
          <div className={f.anatomyFill}>
            <Stack align="row" gap="sm"><Button size="sm" text="Review" /><Button size="sm" variant="outline" text="Later" /></Stack>
          </div>
        </Stack>
      </div>
      <Stack gap="xs" minWidth="0">
        <Typo.SectionTitle tone="tertiary">Anatomy</Typo.SectionTitle>
        <Typo.Caption><Typo.Code>--space-lg</Typo.Code> card padding</Typo.Caption>
        <Typo.Caption><Typo.Code>--space-sm</Typo.Code> title → body → actions</Typo.Caption>
        <Typo.Caption><Typo.Code>--space-sm</Typo.Code> between buttons</Typo.Caption>
        <Typo.Caption tone="tertiary">Hatched areas are the spacing.</Typo.Caption>
      </Stack>
    </div>
  );
}

const RHYTHM: Array<[string, string]> = [
  ["--settings-section-header-gap", "Section header → card"],
  ["--settings-section-padding", "Card inset"],
  ["--settings-field-copy-gap", "Label → description"],
  ["--settings-field-control-gap", "Copy → control"],
  ["--settings-field-gap", "Field → field"],
  ["--settings-section-gap", "Card → next section"],
];

function SettingsRhythm() {
  const [values, probes] = useTokenPx(RHYTHM.map(([name]) => name));
  return (
    <div className={f.rhythm}>
      <Stack gap="sm">
        {probes}
        {RHYTHM.map(([name, meaning]) => (
          <div className={f.rhythmRow} key={name}>
            <span className={f.rhythmBar} style={{ "--step": `var(${name})` } as CSSProperties} />
            <Stack gap="none" minWidth="0">
              <Typo.Code wrap="anywhere">{name}</Typo.Code>
              <Typo.Caption tone="tertiary" numeric="tabular">{`${meaning} · ${Math.round(values[name] ?? 0)}px`}</Typo.Caption>
            </Stack>
          </div>
        ))}
      </Stack>
      <div className={f.rhythmStage}>
        <SettingsPage>
          <SettingsSection id="rhythm-appearance" kind="form" title="Appearance" description="Applies to every window.">
            <SettingsField id="rhythm-translucent" label="Translucent sidebar" description="Show the desktop behind the sidebar."
              control={<Switch id="rhythm-translucent" defaultChecked />} />
            <SettingsField id="rhythm-compact" label="Compact rows" description="Fit more conversations in the sidebar."
              control={<Switch id="rhythm-compact" />} />
          </SettingsSection>
        </SettingsPage>
      </div>
    </div>
  );
}

export function SpacingChapter({ chapter, anchor, locale, onOpen }: ChapterProps) {
  const s = chapterSections(chapter, [
    ["scale", "Scale"], ["gaps", "Gaps in use"], ["anatomy", "Card anatomy"], ["settings-rhythm", "Settings rhythm"],
    ["widths", "Widths and bases"], ["borders", "Borders"],
  ]);
  return (
    <ChapterLayout anchor={anchor} chapter={chapter} locale={locale} onOpen={onOpen} sections={s.list}
      lead="Named steps on a 4px base: xs to 4xl. Layout props take the names (gap, padding); CSS takes the tokens. Space groups related things and separates the rest.">
      <GuideSection spec={s.at("scale")} lead="Nine steps. The small steps sit inside components; lg and up separate blocks and sections.">
        <Staircase tokens={tokens(/^--space-/u)} />
      </GuideSection>
      <GuideSection spec={s.at("gaps")} lead="The same names on Stack, Grid and Section. Hatching shows the gap itself.">
        <GapsInUse />
      </GuideSection>
      <GuideSection spec={s.at("anatomy")} lead="Padding one step larger than the gaps inside keeps a card reading as one object.">
        <CardAnatomy />
      </GuideSection>
      <GuideSection spec={s.at("settings-rhythm")} lead="Settings pages run on their own ramp, applied by SettingsSection and SettingsField. Next to it, the real blocks.">
        <SettingsRhythm />
      </GuideSection>
      <GuideSection spec={s.at("widths")} lead="Page widths and flex bases, scaled against the widest. Values are resolved at this viewport.">
        <WidthBars tokens={tokens(/^--(page-max-width-|layout-basis-)/u)} />
      </GuideSection>
      <GuideSection spec={s.at("borders")} lead="Two widths: hairlines for structure, strong for selection and verdicts.">
        <Stack gap="md">
          {tokens(/^--border-(hairline|width-)/u).map((token) => (
            <div className={f.borderRow} key={token.name}>
              <span className={f.borderLine} style={{ "--step": `var(${token.name})` } as CSSProperties} />
              <Typo.Code>{token.name}</Typo.Code>
              <Typo.Caption tone="tertiary">{token.light}</Typo.Caption>
            </div>
          ))}
          <Typo.Label>One edge, one hairline</Typo.Label>
          {EDGE_RULES.map((rule) => <Typo.Caption key={rule} tone="secondary">{rule}</Typo.Caption>)}
        </Stack>
      </GuideSection>
    </ChapterLayout>
  );
}
