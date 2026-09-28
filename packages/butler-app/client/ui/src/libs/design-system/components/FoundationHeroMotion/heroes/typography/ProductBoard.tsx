import type { ReactNode } from "react";
import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { MarkdownContent } from "../../../../blocks/MarkdownContent";
import { MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow } from "../../../../blocks/MessageRow";
import { MetricCard } from "../../../../blocks/MetricCard";
import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsHeader } from "../../../../blocks/SettingsHeader";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { Card } from "../../../Card";
import { IconButton } from "../../../IconButton";
import { CheckCircle2, MessageSquarePlus, Plus } from "../../../Icons";
import { CopyButton } from "../../../CopyButton";
import { Switch } from "../../../Switch";
import { Typo } from "../../../Typo";
import { LineOverlay } from "./LineOverlay";
import { Sketch } from "./Sketch";
import type { Panel, SketchBox } from "./typeChoreography";
import type { TypeCopy } from "./typeCopy";
import type { TypeLayout } from "./typeGrid";
import type { LineInfo } from "./typeLines";
import t from "./TypographyHero.module.css";

/** A text line of a component, revealed during its build. */
function Line({ id, block = false, children }: { id: string; block?: boolean; children: ReactNode }) {
  return block
    ? <div className={t.line} data-block="" data-line={id} data-t={`line-${id}`}>{children}</div>
    : <span className={t.line} data-line={id} data-t={`line-${id}`}>{children}</span>;
}

/** A non-text piece of a component (control, second card, send), built as structure; `sketch` marks its box for the blueprint. */
function Part({ name, block = false, sketch = false, children }: { name: string; block?: boolean; sketch?: boolean; children: ReactNode }) {
  const mark = sketch ? "" : undefined;
  return block
    ? <div className={t.part} data-block="" data-sketch={mark} data-t={name}>{children}</div>
    : <span className={t.part} data-sketch={mark} data-t={name}>{children}</span>;
}

/** A box of the component the blueprint sketches (card, input, button). */
function Box({ children }: { children: ReactNode }) {
  return <div className={t.sketchBox} data-sketch="">{children}</div>;
}

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
    <div className={t.panel} data-panel={name} data-t={`panel-${name}`} key={name}>
      <div className={t.surface} data-t={`surface-${name}`}>{content}</div>
      <Sketch boxes={sketches[name] ?? []} panel={name} />
      <LineOverlay compact={layout === "tall"} copy={copy} lines={lines.filter((line) => line.panel === name)} />
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
  const conversation = (
    <div className={t.column} key="conversation">
      {panel("chat", (
        <Box>
          <Card padding="md">
            <MessageRow role="user"><Typo.Body><Line id="ask">{copy.ask}</Line></Typo.Body></MessageRow>
            <MessageRow role="assistant" footer={(
              <>
                <MessageFooter>
                  <Part name="chat-icons">
                    <CopyButton label={copy.copy} copiedLabel={copy.copy} text={copy.answer} />
                    <IconButton label={copy.branch}><MessageSquarePlus size="md" /></IconButton>
                  </Part>
                  <Line id="worked">{copy.worked}</Line>
                  <Typo.Caption tone="tertiary" numeric="tabular"><Line id="meta">{copy.meta}</Line></Typo.Caption>
                </MessageFooter>
                <MessageStatusRow>
                  <MessageStatusLabel mark={<Part name="done-mark"><CheckCircle2 size="sm" /></Part>}><Typo.Caption as="span"><Line id="done">{copy.done}</Line></Typo.Caption></MessageStatusLabel>
                </MessageStatusRow>
              </>
            )}>
              <Line id="answer" block>
                <div data-t="wa-i">
                  <MarkdownContent>
                    <p>{copy.answer}</p>
                    <ul>{copy.items.map(([text, code, rest], k) => <li key={k}>{text}{code ? <code>{code}</code> : null}{rest}</li>)}</ul>
                  </MarkdownContent>
                </div>
              </Line>
              <Typo.Code as="div"><Line id="command">{copy.command}</Line></Typo.Code>
            </MessageRow>
          </Card>
        </Box>
      ))}
      {panel("composer", (
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
      ))}
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
