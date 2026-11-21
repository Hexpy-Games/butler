import { useEffect, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { ListGroup, ListRow, Text, ThinkingMark, useHeaderInset, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";
import type { NewChatBriefingView } from "@/settings/types";
import { useConversation } from "./live";
import { useNavigationView } from "./useNavigationView";

export function NewChatIntro({ project, title, dockHeight, setText, onSend }: {
  project?: string; title: string; dockHeight: number; setText(text: string): void; onSend(text: string): void;
}) {
  const t = useTokens();
  const locale = useAppLocale();
  const appCopy = getAppCopy(locale);
  const { client } = useConversation();
  const headerInset = useHeaderInset();
  const { view } = useNavigationView();
  const [briefing, setBriefing] = useState<NewChatBriefingView | null>(null);
  useEffect(() => {
    setBriefing(null);
    if (!client) return;
    let closed = false;
    client.request<NewChatBriefingView>(project ? `/new-chat-briefing?project_id=${encodeURIComponent(project)}` : "/new-chat-briefing")
      .then(next => { if (!closed) setBriefing(next); }).catch(() => { if (!closed) setBriefing(null); });
    return () => { closed = true; };
  }, [client, project]);
  const name = view?.projects.find(item => item.id === project)?.display_name ?? "";
  const suggestions = briefing?.suggestions ?? (project ? appCopy.briefing.projectSuggestions(name) : appCopy.briefing.general.suggestions);
  const moment = briefing?.moment ?? new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date());
  return <ScrollView contentInsetAdjustmentBehavior="never" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
    automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
    contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end", paddingHorizontal: t.length("--space-4"),
      paddingTop: headerInset + t.length("--space-4"), paddingBottom: dockHeight + t.length("--space-4"), gap: t.length("--space-4") }}>
    <View style={{ gap: t.length("--space-2") }}>
      <ThinkingMark working={false} size={t.length("--icon-size-2xl")} />
      <Text variant="caption" tone="tertiary">{moment}</Text>
      <Text variant="h1">{briefing?.title ?? title}</Text>
      {briefing?.description ? <Text tone="secondary">{briefing.description}</Text> : null}
    </View>
    <ListGroup>
      {suggestions.map(suggestion => <ListRow key={suggestion.id} title={suggestion.title}
        onPress={() => suggestion.template ? setText(suggestion.text) : onSend(suggestion.text)} />)}
    </ListGroup>
  </ScrollView>;
}
