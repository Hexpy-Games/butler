import type { ReactNode } from "react";
import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { MessageFooter, MessageRow } from "../../../../blocks/MessageRow";
import { MetricCard } from "../../../../blocks/MetricCard";
import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsHeader } from "../../../../blocks/SettingsHeader";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { Card } from "../../../Card";
import { IconButton } from "../../../IconButton";
import { Plus } from "../../../Icons";
import { Switch } from "../../../Switch";
import { Typo } from "../../../Typo";
import { LineOverlay } from "./LineOverlay";
import type { Panel } from "./typeChoreography";
import type { TypeCopy } from "./typeCopy";
import type { TypeLayout } from "./typeGrid";
import type { LineInfo } from "./typeLines";
import t from "./TypographyHero.module.css";

/** A text line of a component, drawn in during its build. */
function Line({ id, block = false, children }: { id: string; block?: boolean; children: ReactNode }) {
  return block
    ? <div className={t.line} data-block="" data-line={id} data-t={`line-${id}`}>{children}</div>
    : <span className={t.line} data-line={id} data-t={`line-${id}`}>{children}</span>;
}

/** A non-text piece of a component (control, second card, send), built as structure. */
function Part({ name, block = false, children }: { name: string; block?: boolean; children: ReactNode }) {
  return block ? <div className={t.part} data-block="" data-t={name}>{children}</div> : <span className={t.part} data-t={name}>{children}</span>;
}

/**
 * The product the tokens assemble into: real DS blocks with live tokens, so
 * theme, locale and font changes show here as in the app. Wide: a settings
 * section over a dashboard metric (column A) beside a conversation turn over
 * the composer (column B), edges on the grid. Tall: the conversation holds the
 * poster; settings and metric sit below it. Each panel carries the build
 * layer of its own text lines once they are measured.
 */
export function ProductBoard({ copy, layout, lines }: { copy: TypeCopy; layout: TypeLayout; lines: LineInfo[] }) {
  const build = (panel: Panel) => <LineOverlay compact={layout === "tall"} copy={copy} lines={lines.filter((line) => line.panel === panel)} />;
  const settings = (
    <div className={t.panel} data-panel="settings" data-t="panel-settings" key="settings">
      <SettingsHeader title={<Line id="title">{copy.title}</Line>} description={<Line id="lead">{copy.titleLead}</Line>} />
      <SettingsSection id="type-hero-appearance" kind="form">
        <SettingsField label={<Line id="field">{copy.field}</Line>} description={<Line id="hint">{copy.fieldHint}</Line>}
          control={<Part name="switch"><Switch aria-label={copy.field} checked onCheckedChange={() => undefined} /></Part>} />
        <Part name="field-2" block>
          <SettingsField label={copy.field2} description={copy.field2Hint} control={<Switch aria-label={copy.field2} checked={false} onCheckedChange={() => undefined} />} />
        </Part>
      </SettingsSection>
      {build("settings")}
    </div>
  );
  const metric = (
    <div className={t.panel} data-panel="metric" data-t="panel-metric" key="metric">
      <Typo.DashboardTitle as="div"><Line id="dash">{copy.dash}</Line></Typo.DashboardTitle>
      <div className={t.metrics}>
        <MetricCard value={copy.metric} label={copy.metricLabel} change={copy.change} trend="up" />
        <Part name="metric-2" block><MetricCard value={copy.metric2} label={copy.metric2Label} change={copy.change2} trend="up" /></Part>
      </div>
      {build("metric")}
    </div>
  );
  const conversation = (
    <div className={t.column} key="conversation">
      <div className={t.panel} data-panel="chat" data-t="panel-chat">
        <Card padding="md">
          <MessageRow role="user"><Typo.Body><Line id="ask">{copy.ask}</Line></Typo.Body></MessageRow>
          <MessageRow role="assistant" footer={<MessageFooter><Typo.Caption tone="tertiary" numeric="tabular"><Line id="meta">{copy.meta}</Line></Typo.Caption></MessageFooter>}>
            <Line id="answer" block><div data-t="wa-i"><Typo.Body>{copy.answer}</Typo.Body></div></Line>
            <Typo.Code as="div"><Line id="command">{copy.command}</Line></Typo.Code>
          </MessageRow>
        </Card>
        {build("chat")}
      </div>
      <div className={t.panel} data-panel="composer" data-t="panel-composer">
        <ComposerCard>
          <ComposerCardExpandedBody>
            <ComposerCardEditor>
              <ComposerCardEditable><div /></ComposerCardEditable>
              <ComposerCardPlaceholder><Line id="placeholder">{copy.placeholder}</Line></ComposerCardPlaceholder>
            </ComposerCardEditor>
          </ComposerCardExpandedBody>
          <ComposerCardToolbar>
            <IconButton label={copy.more}><Plus size="md" /></IconButton>
            <ComposerCardToolbarSpacer />
            <Part name="send"><ComposerSendButton aria-label={copy.send} mode="send" /></Part>
          </ComposerCardToolbar>
        </ComposerCard>
        {build("composer")}
      </div>
    </div>
  );
  return layout === "wide" ? (
    <div className={t.product} data-t="product">
      <div className={t.columnSpread}>{[settings, metric]}</div>
      {conversation}
    </div>
  ) : (
    <>
      <div className={t.product} data-t="product">{conversation}</div>
      <div className={t.offstage}>{[settings, metric]}</div>
    </>
  );
}
