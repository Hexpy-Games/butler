import { ComposerCard, ComposerCardCompactPreview, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardExpandedControls, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { ComposerControl } from "../../../../blocks/ComposerControl";
import { MarkdownContent } from "../../../../blocks/MarkdownContent";
import { MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow } from "../../../../blocks/MessageRow";
import { ButlerThinkingMark } from "../../../ButlerThinkingMark";
import { CopyButton } from "../../../CopyButton";
import { IconButton } from "../../../IconButton";
import { Plus, ShieldQuestion } from "../../../Icons";
import { RollingStatusLine } from "../../../RollingStatusLine";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import type { MotionCopy } from "./motionCopy";

/**
 * One conversation turn exactly as Butler renders it (checked against the app
 * on an isolated gateway): the user row (bubble, then time and copy), the
 * activity row while the model works (the working mark and the shimmering
 * status), the answer (Markdown, the footer with copy, worked-for and time,
 * then the terminal status row with the settled mark), and the composer.
 * `t` names parts for the timeline (undefined in a still tile).
 */
type Name = (name: string) => string | undefined;

export function UserRow({ copy, t, id }: { copy: MotionCopy; t: Name; id: string }) {
  return (
    <div data-t={t(`${id}-user`)}>
      <MessageRow role="user" footer={(
        <MessageFooter dataTestClass="user-message-footer">
          <Typo.Text as="time" numeric="tabular">{copy.sent}</Typo.Text>
          <CopyButton label={copy.copyMessage} copiedLabel={copy.copyMessage} text={copy.ask} />
        </MessageFooter>
      )}>
        <Typo.Text as="div" data-m={t(`${id}-ask`)} lineClamp={5} wrap="pre">{copy.ask}</Typo.Text>
      </MessageRow>
    </div>
  );
}

/** The activity row while the answer is generated: the working mark beside the status. */
export function ActivityRow({ copy }: { copy: MotionCopy }) {
  return (
    <MessageRow activity role="assistant">
      <Stack gap="md">
        <RollingStatusLine title={copy.generating}>
          <MessageStatusLabel mark={<ButlerThinkingMark state="working" />} shimmer title={copy.generating}>
            <Typo.Body as="p" tone="secondary" weight="regular">{copy.generating}</Typo.Body>
          </MessageStatusLabel>
        </RollingStatusLine>
      </Stack>
    </MessageRow>
  );
}

/** The answer: its text, then (when done) the footer and the terminal status row with the settled mark. */
export function ReplyRow({ copy }: { copy: MotionCopy }) {
  return (
    <MessageRow role="assistant">
      <section aria-label={copy.done}><MarkdownContent><p>{copy.reply}</p></MarkdownContent></section>
      <MessageFooter>
        <CopyButton label={copy.copyResponse} copiedLabel={copy.copyResponse} text={copy.reply} />
        <span>{copy.worked}</span>
        <Typo.Text as="time" numeric="tabular">{copy.sent}</Typo.Text>
      </MessageFooter>
      <MessageStatusRow dataTestClass="assistant-terminal-status-row">
        <MessageStatusLabel mark={<ButlerThinkingMark state="idle" />} title={copy.done}>
          <Typo.Caption as="span">{copy.done}</Typo.Caption>
        </MessageStatusLabel>
      </MessageStatusRow>
    </MessageRow>
  );
}

/** The composer folded between turns: + and the placeholder, with Stop while a turn runs. */
export function CompactComposer({ copy, running }: { copy: MotionCopy; running: boolean }) {
  return (
    <ComposerCard expanded={false}>
      <ComposerCardExpandedBody>
        <ComposerCardEditor><ComposerCardEditable><div /></ComposerCardEditable></ComposerCardEditor>
      </ComposerCardExpandedBody>
      <ComposerCardToolbar>
        <IconButton label={copy.more}><Plus size="md" /></IconButton>
        <ComposerCardCompactPreview data-empty="true">{copy.placeholder}</ComposerCardCompactPreview>
        {running
          ? <ComposerSendButton aria-label={copy.stop} mode="stop" />
          : <ComposerCardExpandedControls><ComposerSendButton aria-label={copy.send} /></ComposerCardExpandedControls>}
      </ComposerCardToolbar>
    </ComposerCard>
  );
}

/** The composer open with the typed request: permission, model, and Send. */
export function DraftComposer({ copy, t }: { copy: MotionCopy; t: Name }) {
  return (
    <ComposerCard>
      <ComposerCardExpandedBody>
        <ComposerCardEditor>
          <ComposerCardEditable><div data-m={t("sc-ed")}>{copy.ask}</div></ComposerCardEditable>
        </ComposerCardEditor>
      </ComposerCardExpandedBody>
      <ComposerCardToolbar>
        <IconButton label={copy.more}><Plus size="md" /></IconButton>
        <ComposerCardExpandedControls>
          <ComposerControl aria-label={`${copy.permission}: ${copy.askFirst}`} compact="icon" icon={<ShieldQuestion size="sm" />} label={copy.askFirst} permissionTone="ask" />
          <ComposerCardToolbarSpacer />
          <ComposerControl detail={copy.effort} label={copy.model} />
          <ComposerSendButton aria-label={copy.send} />
        </ComposerCardExpandedControls>
      </ComposerCardToolbar>
    </ComposerCard>
  );
}
