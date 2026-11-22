import { useEffect, useState } from "react";
import { FlatList, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams } from "expo-router";
import type { LibraryItem, LibraryKind } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { icons, ListGroup, ListRow, Spinner, Surface, Text, useHeaderOptions, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { LibraryItemActions } from "@/library/LibraryItemActions";
import { libraryMeta, libraryTarget } from "@/library/libraryItems";
import { useLibraryItems } from "@/library/useLibraryItems";
import { openResult } from "@/outputs/openResult";
import { LoadState } from "@/settings/layout";

const kindIcons = { scrap: icons.Scrap, document: icons.FileText, bookmark: icons.Bookmark, output: icons.Globe2 };

export default function LibraryItems() {
  const { kind } = useLocalSearchParams<{ kind: LibraryKind }>();
  const locale = useAppLocale(), app = getAppCopy(locale), M = useMobileCopy(), t = useTokens();
  const { pairing } = useConversation();
  const insets = useSafeAreaInsets(), gutter = t.length("--adaptive-page-gutter");
  const [query, setQuery] = useState(""), [q, setQ] = useState("");
  const [selected, select] = useState<LibraryItem | null>(null);
  useEffect(() => { const timer = setTimeout(() => setQ(query), 300); return () => clearTimeout(timer); }, [query]);
  const { items, loading, failed, more, reload } = useLibraryItems(kind, q);
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...useHeaderOptions(), title: app.library.kinds[kind], headerSearchBarOptions: {
      placeholder: app.library.search, hideWhenScrolling: false, onChangeText: e => setQuery(e.nativeEvent.text),
    } }} />
    <FlatList data={items} keyExtractor={item => item.id} contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: gutter + (Platform.OS === "android" ? insets.bottom : 0) }}
      onEndReached={more} onEndReachedThreshold={0.5} renderItem={({ item }) => {
        const target = libraryTarget(item);
        return <ListRow icon={kindIcons[kind]} title={item.title} description={libraryMeta(item, locale)} descriptionLines={1}
          navigates={!!target && target.kind !== "image"} onPress={target ? () => openResult(target, pairing!, M.outputs.loadFailed) : undefined}
          onLongPress={() => select(item)} />;
      }} ListEmptyComponent={failed ? <ListGroup><LoadState error onRetry={reload} /></ListGroup>
        : loading ? <Spinner label={app.settings.sectionState.loading} /> : <Text tone="secondary">{q ? app.library.noMatches : app.library.noItems}</Text>}
      ListFooterComponent={loading && items.length ? <Spinner label={app.settings.sectionState.loading} /> : undefined} />
    <LibraryItemActions item={selected} onClose={() => select(null)} onChanged={reload} />
  </Surface>;
}
