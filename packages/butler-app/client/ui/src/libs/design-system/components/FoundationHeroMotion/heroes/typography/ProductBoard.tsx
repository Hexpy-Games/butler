import { Fragment, type ReactNode } from "react";
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
import type { TypeCopy } from "./typeCopy";
import type { TypeLayout } from "./typeGrid";
import type { Flight } from "./typeChoreography";
import t from "./TypographyHero.module.css";

/** Where a rung's sample lands: the real text inside a real component. */
function Land({ at, children }: { at: Flight; children: ReactNode }) {
  return <span className={t.land} data-land={at} data-t={`land-${at}`}>{children}</span>;
}

/** A piece of a component that cascades in after its text lands. */
function Part({ name, block = false, children }: { name: string; block?: boolean; children: ReactNode }) {
  return block ? <div className={t.part} data-block="" data-t={name}>{children}</div> : <span className={t.part} data-t={name}>{children}</span>;
}

/**
 * The product the tokens assemble into: real DS blocks with live tokens, so
 * theme, locale and font changes show here as in the app. Wide: a settings
 * section over a dashboard metric (column A) beside a conversation turn over
 * the composer (column B), edges on the grid. Tall: the conversation holds the
 * poster; settings and metric wait below it for the camera.
 */
export function ProductBoard({ copy, layout }: { copy: TypeCopy; layout: TypeLayout }) {
  const settings = (
    <div className={t.panel} data-panel="settings" data-t="panel-settings" key="settings">
      <SettingsHeader title={<Land at="title">{copy.title}</Land>} description={<Part name="settings-lead">{copy.titleLead}</Part>} />
      <SettingsSection id="type-hero-appearance" kind="form">
        <SettingsField label={<Land at="field">{copy.field}</Land>} description={<Part name="field-hint">{copy.fieldHint}</Part>}
          control={<Part name="switch"><Switch aria-label={copy.field} checked onCheckedChange={() => undefined} /></Part>} />
        <Part name="field-2" block>
          <SettingsField label={copy.field2} description={copy.field2Hint} control={<Switch aria-label={copy.field2} checked={false} onCheckedChange={() => undefined} />} />
        </Part>
      </SettingsSection>
    </div>
  );
  const metric = (
    <div className={t.panel} data-panel="metric" data-t="panel-metric" key="metric">
      <Typo.DashboardTitle as="div"><Land at="dash">{copy.dash}</Land></Typo.DashboardTitle>
      <div className={t.metrics}>
        <MetricCard value={copy.metric} label={copy.metricLabel} change={copy.change} trend="up" />
        <Part name="metric-2" block><MetricCard value={copy.metric2} label={copy.metric2Label} change={copy.change2} trend="up" /></Part>
      </div>
    </div>
  );
  const conversation = (
    <div className={t.column} key="conversation">
      <div className={t.panel} data-panel="chat" data-t="panel-chat">
        <Card padding="md">
          <MessageRow role="user"><Typo.Body><Land at="ask">{copy.ask}</Land></Typo.Body></MessageRow>
          <MessageRow role="assistant" footer={<MessageFooter><Typo.Caption tone="tertiary" numeric="tabular"><Land at="meta">{copy.meta}</Land></Typo.Caption></MessageFooter>}>
            <Part name="answer" block><Typo.Body>{copy.answer}</Typo.Body></Part>
            <Typo.Code as="div"><Land at="command">{copy.command}</Land></Typo.Code>
          </MessageRow>
        </Card>
      </div>
      <div className={t.panel} data-panel="composer" data-t="panel-composer">
        <ComposerCard>
          <ComposerCardExpandedBody>
            <ComposerCardEditor>
              <ComposerCardEditable><div /></ComposerCardEditable>
              <ComposerCardPlaceholder>
                {copy.placeholder.split(" ").map((word, k) => <Fragment key={k}>{k > 0 ? " " : null}<Part name={`word-${k}`}>{word}</Part></Fragment>)}
              </ComposerCardPlaceholder>
            </ComposerCardEditor>
          </ComposerCardExpandedBody>
          <ComposerCardToolbar>
            <IconButton label={copy.more}><Plus size="md" /></IconButton>
            <ComposerCardToolbarSpacer />
            <Part name="send"><ComposerSendButton aria-label={copy.send} mode="send" /></Part>
          </ComposerCardToolbar>
        </ComposerCard>
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
