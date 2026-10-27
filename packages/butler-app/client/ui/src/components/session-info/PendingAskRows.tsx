import type { PendingAsk } from "@/app/pendingAsks.ts";
import { appCopy } from "@/app/copy.ts";
import { relativeAge } from "@/app/utils.ts";
import { useMinuteClock } from "@/app/space/minute-clock.ts";
import { useButlerStore } from "@/app/store.ts";
import { useMessageNavigation } from "@/app/messageNavigation.ts";
import { Clickable, IconSlot, MessageSquare, Notebook, ShieldQuestion, Stack, Typo } from "@/butler-ds";

export function PendingAskRows({ asks }: { asks: PendingAsk[] }) {
  useMinuteClock(asks.length > 0);
  return asks.map(ask => {
    const row = <Stack align="row" cross="start" gap="sm">
      <IconSlot size="sm" minHeight="line" tone="secondary">
        {ask.kind === "approval" ? <ShieldQuestion size="sm" /> : ask.kind === "canon_proposal" ? <Notebook size="sm" /> : <MessageSquare size="sm" />}
      </IconSlot>
      <Stack gap="xs">
        <Typo.Body wrap="anywhere">{ask.title}</Typo.Body>
        {ask.target_label && <Typo.Caption tone="secondary">{ask.target_label}</Typo.Caption>}
        <Typo.Caption tone="secondary">{askMeta(ask)}</Typo.Caption>
      </Stack>
    </Stack>;
    return ask.source_message_id ? <Clickable variant="text" key={ask.ask_id} stretch onClick={() => void openAskSource(ask)}>{row}</Clickable>
      : <div key={ask.ask_id}>{row}</div>;
  });
}

function askMeta(ask: PendingAsk): string {
  const c = appCopy.sessionInfo;
  const time = relativeAge(ask.waiting_since);
  return [ask.kind === "approval" ? c.approval : ask.kind === "canon_proposal" ? appCopy.canon.epic : c.question, time, ask.deferred ? c.deferred : null].filter(Boolean).join(" · ");
}

async function openAskSource(ask: PendingAsk) {
  if (!ask.source_message_id) return;
  const store = useButlerStore.getState();
  if (store.activeChatId !== ask.source_session_id) await store.openSession(ask.source_session_id);
  useMessageNavigation.setState({ target: { sessionId: ask.source_session_id, messageId: ask.source_message_id } });
}
