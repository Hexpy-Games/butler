import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import type { NavigationView } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { Button, icons, ListRow, Sheet, showToast, TextField, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useConversation } from "./live";
import { spaceTree, visibleRows, type SpaceRow } from "./space";

export function RowActions({ row, view, tree, onClose, onChanged }: {
  row: SpaceRow | null; view: NavigationView | null; tree: ReturnType<typeof spaceTree>; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const { client } = useConversation();
  const appCopy = getAppCopy(useAppLocale());
  const copy = useMobileCopy();
  const t = useTokens();
  const [stage, setStage] = useState<"menu" | "rename" | "subgroup" | "move" | "delete">("menu");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setStage("menu"); }, [row]);
  const revision = view?.space.revision ?? 0;
  const run = async (path: string, init: { method?: string; body?: unknown }) => {
    if (!client || busy) return;
    setBusy(true);
    try { await client.request(path, init); onClose(); await onChanged(); }
    catch { showToast({ message: appCopy.space.saveFailed, tone: "warning" }); }
    finally { setBusy(false); }
  };
  const kind = row?.kind;
  const id = kind === "session" ? row?.session?.id : kind === "project" ? row?.project?.id : row?.key.slice(2);
  const groupScope = view?.space.groups.find(g => g.id === id)?.scopeProjectId;
  const save = () => {
    const title = name.trim();
    if (stage === "subgroup") return run("/space/groups", { body: { action: "create", title, parentKey: row?.key, expectedRevision: revision } });
    if (kind === "session") return run(`/sessions/${id}`, { method: "PATCH", body: { title } });
    if (kind === "project") return run(`/projects/${id}`, { method: "PATCH", body: { display_name: title } });
    return run(`/space/groups/${id}`, { method: "PATCH", body: { action: "rename", groupId: id, title, expectedRevision: revision } });
  };
  const excluded = new Set(row ? [row.key] : []);
  if (stage === "move") for (const key of excluded) {
    for (const child of tree.children.get(key) ?? []) excluded.add(child.key);
  }
  const destinations = stage === "move" ? [
    { key: null, title: appCopy.space.root, depth: 0, scope: null, icon: icons.Folder },
    ...visibleRows(tree, new Set()).filter(item => item.kind !== "session" && !excluded.has(item.key)).map(item => ({
      key: item.key, title: item.title, depth: item.depth, icon: item.kind === "project" ? icons.Briefcase : icons.Folder,
      scope: item.kind === "project" ? item.project!.id : view?.space.groups.find(g => "g:" + g.id === item.key)?.scopeProjectId ?? null,
    })),
  ].filter(destination => kind !== "session" || destination.scope === (row?.session?.project_id ?? null)) : [];
  return <Sheet open={!!row && !!view} onClose={onClose} cancelLabel={copy.chat.close}
    title={stage === "menu" ? row?.title ?? "" : stage === "move" ? appCopy.space.moveDestination
      : stage === "delete" ? appCopy.space.deleteProject : stage === "rename" ? appCopy.space.rename : appCopy.space.subgroup}
    description={stage === "move" ? appCopy.space.moveDescription : stage === "delete" ? appCopy.sidebar.projectDeleteConfirm(row?.title ?? "") : undefined}
    action={stage === "rename" || stage === "subgroup" ? <Button label={appCopy.space.save} disabled={!name.trim() || busy} onPress={save} />
      : stage === "delete" ? <Button variant="destructive" label={appCopy.common.delete} disabled={busy}
        onPress={() => run(`/projects/${id}?permanent=true`, { method: "DELETE" })} /> : undefined}>
    {stage === "menu" ? <>
      {kind !== "session" ? <>
        <ListRow icon={icons.MessageSquare} title={appCopy.space.newChat} onPress={() => {
          onClose();
          router.push({ pathname: "/chat/new", params: kind === "project" ? { project: id } : { group: id, ...(groupScope ? { project: groupScope } : {}) } });
        }} />
        <ListRow icon={icons.Folder} title={appCopy.space.subgroup} onPress={() => { setName(""); setStage("subgroup"); }} />
      </> : null}
      <ListRow icon={icons.Edit} title={appCopy.space.rename} onPress={() => { setName(row?.title ?? ""); setStage("rename"); }} />
      <ListRow icon={icons.Folder} title={appCopy.space.moveMenu} onPress={() => setStage("move")} />
      {kind === "group" ? <ListRow icon={icons.Delete} title={appCopy.space.dissolve}
        onPress={() => run(`/space/groups/${id}`, { method: "DELETE", body: { action: "dissolve", groupId: id, expectedRevision: revision } })} />
        : <ListRow icon={icons.Archive} title={appCopy.space.archive} onPress={() => run(`/${kind === "session" ? "sessions" : "projects"}/${id}/archive`, { body: {} })} />}
      {kind === "project" ? <ListRow icon={icons.Delete} title={appCopy.space.deleteProject} onPress={() => setStage("delete")} /> : null}
    </> : stage === "rename" || stage === "subgroup" ? <TextField autoFocus returnKeyType="done" onSubmitEditing={save} value={name} onChangeText={setName}
      label={stage === "subgroup" || kind === "group" ? appCopy.space.groupName : kind === "session" ? appCopy.interfaceStatus.conversationTitle : appCopy.interfaceStatus.projectName} />
      : stage === "move" ? destinations.map(destination => <View key={destination.key ?? "root"} style={{ paddingLeft: destination.depth * t.length("--space-4") }}>
        <ListRow icon={destination.icon} title={destination.title} onPress={() => run("/space/moves", {
          body: { action: "move", sourceKey: row?.key, targetKey: destination.key, position: "inside", expectedRevision: revision },
        })} />
      </View>) : null}
  </Sheet>;
}
