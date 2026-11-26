import { View } from "react-native";
import { router } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { SessionSummary } from "../../../butler-protocol/src/index.ts";
import { Badge, ButlerMark, icons, ListGroup, ListRow, Spinner, Text, UnreadDot, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { sessionMark } from "@/conversation/sessions";

export function HomeShortcuts({ status, general }: { status?: string; general?: SessionSummary }) {
  const t = useTokens(), app = getAppCopy(useAppLocale()), M = useMobileCopy();
  const mark = general ? sessionMark(general) : null;
  const title = app.space.general;
  return <View style={{ gap: t.length("--space-4"), paddingTop: t.length("--space-6"), paddingBottom: t.length("--space-4") }}>
    <ListGroup>
      <ListRow icon={icons.Archive} title={app.library.title} navigates onPress={() => router.push("/library")} />
      <ListRow icon={icons.Clock3} title={app.automations.title} navigates onPress={() => router.push("/automations")} />
    </ListGroup>
    {general ? <ListGroup>
      <ListRow icon={<ButlerMark size={t.length("--icon-size-lg")} color={t.color("--text-primary")} />} title={title}
        trailing={mark === "attention" ? <Badge tone="warning" label={M.conversations.needsAttention} />
          : mark === "working" ? <Spinner label={M.conversations.working} />
          : mark === "unread" ? <UnreadDot label={M.conversations.unread} /> : undefined}
        navigates onPress={() => router.push({ pathname: "/chat/[id]", params: { id: general.id, title } })} />
    </ListGroup> : null}
    {status ? <Text variant="caption" tone="tertiary">{status}</Text> : null}
  </View>;
}
