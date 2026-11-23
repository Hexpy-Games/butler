import { useEffect, useState } from "react";
import { Platform, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams } from "expo-router";
import type { LibraryItem, LibraryKind } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { icons, ListGroup, ListGroupItem, ListRow, Surface, Text, useHeaderOptions, useTokens } from "@/ds";
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
  const { items, loading, failed, more, reload, hasMore } = useLibraryItems(kind, q);
  return <Surface variant="base" grow edges={["left", "right"]}>
    <Stack.Screen options={{ ...useHeaderOptions(), title: app.library.kinds[kind], headerSearchBarOptions: {
      placeholder: app.library.search, hideWhenScrolling: false, onChangeText: e => setQuery(e.nativeEvent.text),
    } }} />
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: gutter, paddingBottom: gutter + (Platform.OS === "android" ? insets.bottom : 0), gap: t.length("--space-6") }}>
      <ListGroup>
        {failed && !items.length ? <LoadState error onRetry={reload} /> : loading && !items.length ? <LoadState error={false} onRetry={reload} /> : <>
          {items.map(item => {
            const target = libraryTarget(item);
            return <ListRow key={item.id} icon={kindIcons[kind]} title={item.title} description={libraryMeta(item, locale)} descriptionLines={1}
              navigates={!!target} onPress={target ? () => openResult(target, pairing!, M.outputs.loadFailed, app) : undefined}
              onLongPress={() => select(item)} />;
          })}
          {!items.length ? <ListGroupItem><Text variant="caption">{q ? app.library.noMatches : app.library.noItems}</Text></ListGroupItem> : null}
        </>}
        {hasMore ? <ListRow title={app.common.more} accent disabled={loading} onPress={more} /> : null}
      </ListGroup>
    </ScrollView>
    <LibraryItemActions item={selected} onClose={() => select(null)} onChanged={reload} />
  </Surface>;
}
