import { View } from "react-native";
import { router } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { Button, ButtonGroup, icons, ListRow, SearchField, Spinner, Text, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";
import { useChatSearch } from "./useChatSearch";

export function HomeSearch({ query, onQueryChange }: { query: string; onQueryChange(query: string): void }) {
  const t = useTokens();
  const app = getAppCopy(useAppLocale());
  const { state, hits, retry } = useChatSearch(query);
  return <>
    <SearchField value={query} onChangeText={onQueryChange} placeholder={app.composer.usage.search}
      clearLabel={app.composer.modelSearchClear} cancelLabel={app.common.cancel} onCancel={() => onQueryChange("")} />
    {query.trim() !== "" ? hits.length ? (
      <View>{hits.map(({ id, kind, title, subtitle }) => <ListRow key={id} icon={kind === "project_session" ? icons.Notebook : icons.MessageSquare}
        title={title} description={subtitle} descriptionLines={1} navigates
        onPress={() => router.push({ pathname: "/chat/[id]", params: { id, title } })} />)}</View>
    ) : (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: t.length("--space-4") }}>
        {state === "loading" ? <Spinner label={app.commandPalette.loading} /> : null}
        {state === "empty" ? <Text tone="secondary">{app.commandPalette.empty}</Text> : null}
        {state === "failed" ? <>
          <Text tone="danger">{app.commandPalette.failed}</Text>
          <ButtonGroup><Button label={app.mobile.home.retry} onPress={retry} /></ButtonGroup>
        </> : null}
      </View>
    ) : null}
  </>;
}
