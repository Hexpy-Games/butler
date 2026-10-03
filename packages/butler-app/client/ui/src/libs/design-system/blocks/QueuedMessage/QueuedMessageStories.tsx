import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Stack } from "../../components/Stack";
import {
  ComposerCard,
  ComposerCardTextarea,
  ComposerCardToolbar,
  ComposerCardToolbarSpacer,
  ComposerSendButton,
} from "../ComposerCard";
import { QueuedMessage, type QueuedMessageTone } from "./QueuedMessage";
import { queuedShowcaseCopy, type QueuedShowcaseCopy } from "./QueuedMessage.showcaseCopy";

/** Showcase wrapper: showcase copy plus no-op handlers unless given. */
export function ShowcaseQueued({ copy, children, status, first = false, tone, onSendNow, onEdit, onDelete, entering }: {
  copy: QueuedShowcaseCopy;
  children: string;
  status: string;
  first?: boolean;
  tone?: QueuedMessageTone;
  onSendNow?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  entering?: boolean;
}) {
  const failed = tone === "failed";
  return (
    <QueuedMessage
      status={status}
      tone={tone}
      entering={entering}
      editLabel={failed ? copy.retry : copy.edit}
      deleteLabel={failed ? copy.removeFailed : copy.remove}
      sendNowLabel={copy.sendNow}
      sendNowHint={copy.sendNowHint}
      showMoreLabel={copy.showMore}
      showLessLabel={copy.showLess}
      onSendNow={first && !failed ? onSendNow ?? (() => undefined) : undefined}
      onEdit={onEdit ?? (() => undefined)}
      onDelete={onDelete ?? (() => undefined)}
    >
      {children}
    </QueuedMessage>
  );
}

export function SeveralStory({ context }: { context: ShowcaseRenderContext }) {
  const copy = queuedShowcaseCopy(context);
  const [items, setItems] = useState<string[]>([...copy.messages]);
  return (
    <Stack gap="none">
      {items.map((item, index) => (
        <ShowcaseQueued key={item} copy={copy} first={index === 0}
          status={items.length > 1 ? copy.position(index + 1, items.length) : copy.queued}
          onDelete={() => setItems((current) => current.filter((value) => value !== item))}>
          {item}
        </ShowcaseQueued>
      ))}
    </Stack>
  );
}

/** Edit moves the queued text back into the composer and removes the row. */
export function EditingStory({ context }: { context: ShowcaseRenderContext }) {
  const copy = queuedShowcaseCopy(context);
  const [queued, setQueued] = useState(true);
  const [draft, setDraft] = useState("");
  return (
    <Stack gap="md">
      {queued ? (
        <ShowcaseQueued copy={copy} first status={copy.queued}
          onEdit={() => { setDraft(copy.messages[0]); setQueued(false); }}>
          {copy.messages[0]}
        </ShowcaseQueued>
      ) : null}
      <ComposerCard onSubmit={(event) => { event.preventDefault(); setQueued(true); setDraft(""); }} controls={<ComposerCardToolbar>
          <ComposerCardToolbarSpacer />
          <ComposerSendButton aria-label={copy.send} />
        </ComposerCardToolbar>}>
        <ComposerCardTextarea value={draft} onChange={(event) => setDraft(event.target.value)}
          placeholder={copy.placeholder} rows={2} />

      </ComposerCard>
    </Stack>
  );
}
