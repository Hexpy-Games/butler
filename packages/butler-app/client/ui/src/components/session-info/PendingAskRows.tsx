import type { PendingAsk } from "@/app/pendingAsks.ts";
import { appCopy, getAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useMessageNavigation } from "@/app/messageNavigation.ts";
import { Clickable, IconSlot, MessageSquare, ShieldQuestion, Stack, Typo } from "@/butler-ds";

export function PendingAskRows({ asks }: { asks: PendingAsk[] }) {
  return asks.map(ask => {
    const row = <Stack align="row" cross="start" gap="sm">
      <IconSlot size="sm" minHeight="line" tone="secondary">
        {ask.kind === "approval" ? <ShieldQuestion size="sm" /> : <MessageSquare size="sm" />}
      </IconSlot>
      <Stack gap="xs">
        <Typo.Body wrap="anywhere">{ask.title}</Typo.Body>
        <Typo.Caption tone="secondary">{askMeta(ask)}</Typo.Caption>
      </Stack>
    </Stack>;
    return ask.source_message_id ? <Clickable variant="text" key={ask.ask_id} stretch onClick={() => void openAskSource(ask)}>{row}</Clickable>
      : <div key={ask.ask_id}>{row}</div>;
  });
}

function askMeta(ask: PendingAsk): string {
  const c = appCopy.sessionInfo;
  const elapsed = Math.max(0, Date.now() - Date.parse(ask.waiting_since));
  const unit = elapsed >= 86400000 ? "day" : elapsed >= 3600000 ? "hour" : "minute";
  const divisor = unit === "day" ? 86400000 : unit === "hour" ? 3600000 : 60000;
  const time = new Intl.RelativeTimeFormat(getAppLocale(), { numeric: "auto" }).format(-Math.floor(elapsed / divisor), unit);
  return [ask.kind === "approval" ? c.approval : c.question, time, ask.deferred ? c.deferred : null].filter(Boolean).join(" · ");
}

async function openAskSource(ask: PendingAsk) {
  if (!ask.source_message_id) return;
  const store = useButlerStore.getState();
  if (store.activeChatId !== ask.source_session_id) await store.openSession(ask.source_session_id);
  useMessageNavigation.setState({ target: { sessionId: ask.source_session_id, messageId: ask.source_message_id } });
}
