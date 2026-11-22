import { useCallback, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import type { LibraryFacets, LibraryKind } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { icons, ListGroup, ListRow } from "@/ds";
import { useAppLocale } from "@/i18n";
import { libraryKindParams } from "@/library/libraryItems";
import { SettingsScreen } from "@/settings/layout";

const kinds: LibraryKind[] = ["scrap", "document", "bookmark", "output"];
const kindIcons = { scrap: icons.Scrap, document: icons.FileText, bookmark: icons.Bookmark, output: icons.Globe2 };

export default function Library() {
  const app = getAppCopy(useAppLocale());
  const { client } = useConversation();
  const [counts, setCounts] = useState<number[]>();
  useFocusEffect(useCallback(() => {
    if (!client) return;
    void Promise.all(kinds.map(k => client!.request<LibraryFacets>(`/library/facets?${libraryKindParams(k)}`).then(f => f.total)))
      .then(setCounts).catch(() => {});
  }, [client]));
  return <SettingsScreen title={app.library.title}>
    <ListGroup>{kinds.map((k, index) => <ListRow key={k} icon={kindIcons[k]} title={app.library.kinds[k]}
      meta={counts ? String(counts[index]) : undefined} navigates onPress={() => router.push({ pathname: "/library/[kind]", params: { kind: k } })} />)}</ListGroup>
  </SettingsScreen>;
}
