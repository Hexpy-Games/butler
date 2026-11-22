import { View } from "react-native";
import { router } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { icons, ListGroup, ListRow, Text, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";

export function HomeShortcuts({ lost }: { lost: boolean }) {
  const t = useTokens(), app = getAppCopy(useAppLocale()), M = useMobileCopy();
  return <View style={{ gap: t.length("--space-4"), paddingBottom: t.length("--space-4") }}>
    <ListGroup>
      <ListRow icon={icons.Archive} title={app.library.title} navigates onPress={() => router.push("/library")} />
      <ListRow icon={icons.Clock3} title={app.automations.title} navigates onPress={() => router.push("/automations")} />
    </ListGroup>
    {lost ? <Text variant="caption" tone="tertiary">{M.conversations.reconnecting}</Text> : null}
  </View>;
}
