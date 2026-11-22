import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import type { LibraryItem } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, icons, ListGroup, ListRow, Sheet, showToast, TextField, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { goesToChat } from "./libraryItems";

export function LibraryItemActions({ item, onClose, onChanged }: {
  item: LibraryItem | null; onClose(): void; onChanged(): Promise<void>;
}) {
  const { client } = useConversation();
  const app = getAppCopy(useAppLocale()), M = useMobileCopy(), t = useTokens();
  const [stage, setStage] = useState<"menu" | "rename" | "delete">("menu");
  const [name, setName] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { setStage("menu"); setName(item?.title ?? ""); }, [item]);
  const change = async () => {
    setBusy(true);
    try {
      if (stage === "rename") await client!.request("/library/items", { method: "PATCH", body: { ids: [item!.id], title: name.trim() } });
      else await client!.request(`/library/${encodeURIComponent(item!.id)}`, { method: "DELETE" });
      onClose(); await onChanged();
    } catch { showToast({ message: M.library.changeFailed, tone: "warning" }); }
    finally { setBusy(false); }
  };
  return <Sheet open={!!item} onClose={onClose} cancelLabel={M.chat.close}
    title={stage === "menu" ? item?.title ?? "" : stage === "rename" ? app.library.rename : app.common.delete}
    description={stage === "delete" && item ? app.interfaceTemplates.deleteItem(item.title) : undefined}
    action={stage === "rename" ? <Button label={app.library.save} disabled={!name.trim() || busy} onPress={change} />
      : stage === "delete" ? <Button variant="destructive" label={app.common.delete} onPress={change} /> : undefined}>
    {stage === "menu" ? <View style={{ gap: t.length("--space-4") }}>
      <ListGroup>
        <ListRow icon={icons.Edit} title={app.library.rename} onPress={() => setStage("rename")} />
        {item && goesToChat(item) ? <ListRow icon={icons.MessageSquare} title={app.fileViewer.goToChat} onPress={() => {
          onClose(); router.push({ pathname: "/chat/[id]", params: { id: item.session!, title: "" } });
        }} /> : null}
      </ListGroup>
      <ListGroup><ListRow icon={icons.Delete} destructive title={app.library.deleteItem} onPress={() => setStage("delete")} /></ListGroup>
    </View> : stage === "rename" ? <TextField label={app.library.name} autoFocus returnKeyType="done" value={name} onChangeText={setName} /> : null}
  </Sheet>;
}
