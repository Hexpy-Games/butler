import type { CSSProperties, ReactNode } from "react";
import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { MetricCard } from "../../../../blocks/MetricCard";
import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsHeader } from "../../../../blocks/SettingsHeader";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { IconButton } from "../../../IconButton";
import { Plus } from "../../../Icons";
import { Switch } from "../../../Switch";
import { Typo } from "../../../Typo";
import { Box, Line, Part } from "./BuildParts";
import { ChatTurn } from "./ChatTurn";
import { LineOverlay } from "./LineOverlay";
import { Sketch } from "./Sketch";
import type { Panel, SketchBox } from "./typeChoreography";
import type { TypeCopy } from "./typeCopy";
import type { TypeLayout } from "./typeGrid";
import { LINES, tagBand, type LineInfo } from "./typeLines";
import t from "./TypographyHero.module.css";

/**
 * The product the tokens assemble into: real DS blocks with live tokens, so
 * theme, locale and font changes show here as in the app. Wide: a settings
 * section over a dashboard metric (column A) beside a conversation turn over
 * the composer (column B), edges on the grid. Tall: the conversation holds the
 * poster; settings and metric sit below it. Each panel is a surface (the real
 * component) with its blueprint sketch and text build layered over it.
 */
export function ProductBoard({ copy, layout, lines, sketches }: { copy: TypeCopy; layout: TypeLayout; lines: LineInfo[]; sketches: Partial<Record<Panel, SketchBox[]>> }) {
  const panel = (name: Panel, content: ReactNode) => (
    <div className={t.panel} data-panel={name} data-t={`panel-${name}`} key={name}
      style={{ "--tag-band": `${tagBand(LINES.filter((line) => line.panel === name && !line.secondary).length)}px` } as CSSProperties}>
      <div className={t.surface} data-t={`surface-${name}`}>{content}</div>
      <Sketch boxes={sketches[name] ?? []} panel={name} />
      <LineOverlay compact={layout === "tall"} copy={copy} height={sketches[name]?.[0]?.h ?? 0} lines={lines.filter((line) => line.panel === name)} />
    </div>
  );
  const settings = panel("settings", <>
    <SettingsHeader title={<Line id="title">{copy.title}</Line>} description={<Line id="lead">{copy.titleLead}</Line>} />
    <Box>
      <SettingsSection id="type-hero-appearance" kind="form">
        <SettingsField label={<Line id="field">{copy.field}</Line>} description={<Line id="hint">{copy.fieldHint}</Line>}
          control={<Part name="switch" sketch><Switch aria-label={copy.field} checked onCheckedChange={() => undefined} /></Part>} />
        <SettingsField label={<Line id="field2">{copy.field2}</Line>} description={<Line id="hint2">{copy.field2Hint}</Line>}
          control={<Part name="switch-2" sketch><Switch aria-label={copy.field2} checked={false} onCheckedChange={() => undefined} /></Part>} />
      </SettingsSection>
    </Box>
  </>);
  const metric = panel("metric", <>
    <Typo.DashboardTitle as="div"><Line id="dash">{copy.dash}</Line></Typo.DashboardTitle>
    <div className={t.metrics}>
      <Box><MetricCard value={copy.metric} label={copy.metricLabel} change={copy.change} trend="up" /></Box>
      <Part name="metric-2" block sketch><MetricCard value={copy.metric2} label={copy.metric2Label} change={copy.change2} trend="up" /></Part>
    </div>
  </>);
  const chat = panel("chat", <ChatTurn copy={copy} />);
  const composer = panel("composer", (
        <Box>
          <ComposerCard>
            <ComposerCardExpandedBody>
              <ComposerCardEditor>
                <ComposerCardEditable><div /></ComposerCardEditable>
                <ComposerCardPlaceholder><Line id="placeholder">{copy.placeholder}</Line></ComposerCardPlaceholder>
              </ComposerCardEditor>
            </ComposerCardExpandedBody>
            <ComposerCardToolbar>
              <Part name="more"><IconButton label={copy.more}><Plus size="md" /></IconButton></Part>
              <ComposerCardToolbarSpacer />
              <Part name="send" sketch><ComposerSendButton aria-label={copy.send} mode="send" /></Part>
            </ComposerCardToolbar>
          </ComposerCard>
        </Box>
      ));
  const conversation = <div className={t.column} key="conversation">{chat}{composer}</div>;
  return layout === "wide" ? (
    <div className={t.product} data-t="product">
      <div className={t.columnSpread}>{[settings, metric]}</div>
      {conversation}
    </div>
  ) : (
    // Tall: one column in build order, so the camera steps straight down it.
    <div className={t.product} data-t="product">{[settings, chat, metric, composer]}</div>
  );
}
