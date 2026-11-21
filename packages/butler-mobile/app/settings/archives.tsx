import { useCallback, useEffect, useState } from "react";
import { router } from "expo-router";
import { getAppCopy, type AppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, ListRow, Sheet, Text, showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { GroupInset, LoadState, SettingsGroup, SettingsScreen } from "@/settings/layout";
import { relativeAge } from "@/settings/format";
import type { ArchiveListView, SessionSummary } from "@/settings/types";

type ArchiveItem = { kind: "project" | "session"; id: string; title: string; updatedAt: string; session?: SessionSummary };
function archiveItems(view: ArchiveListView | null, untitled: string): ArchiveItem[] {
  if (!view) return [];
  return [...view.projects.map((p): ArchiveItem => ({ kind: "project", id: p.id, title: p.display_name, updatedAt: p.last_activity_at })),
    ...view.sessions.map((s): ArchiveItem => ({ kind: "session", id: s.id, title: s.title || untitled, updatedAt: s.last_activity_at, session: s }))]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function archiveSubtitle(item: ArchiveItem, app: AppCopy) {
  if (item.kind === "project") return app.interfaceDetails.project;
  if (item.session?.kind !== "project") return app.interfaceDetails.generalConversation;
  return app.interfaceTemplates.projectConversation(item.session.project?.display_name ?? item.session.project_id ?? app.interfaceDetails.unknownProject);
}

function useArchives() {
  const { client, reconcile } = useConversation();
  const S = getAppCopy(useAppLocale()).settings;
  const [view, setView] = useState<ArchiveListView | null>(null), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const load = useCallback(async (offset = 0) => {
    if (!client) return;
    setError(false); setBusy(true);
    try {
      const next = await client.request<ArchiveListView>(`/archives?limit=20&offset=${offset}`);
      setView(old => offset ? { ...next, projects: [...(old?.projects ?? []), ...next.projects], sessions: [...(old?.sessions ?? []), ...next.sessions] } : next);
    } catch {
      if (offset) showToast({ message: S.archiveErrors.loadMore, tone: "error" });
      else setError(true);
    } finally { setBusy(false); }
  }, [client, S.archiveErrors.loadMore]);
  useEffect(() => { void load(); }, [load, reconcile]);
  const change = async (item: ArchiveItem, remove: boolean) => {
    if (!client || busy) return;
    setBusy(true);
    try {
      await client.request(`/${item.kind === "project" ? "projects" : "sessions"}/${encodeURIComponent(item.id)}${remove ? "?permanent=true" : ""}`,
        remove ? { method: "DELETE" } : { method: "PATCH", body: { archived: false } });
      await load();
    } catch { showToast({ message: remove ? S.archiveErrors.remove : S.archiveErrors.restore, tone: "error" }); }
    finally { setBusy(false); }
  };
  return { view, error, busy, load, change };
}

export default function ArchivesSettings() {
  const app = getAppCopy(useAppLocale()), S = app.settings, M = useMobileCopy();
  const archives = useArchives(), items = archiveItems(archives.view, M.conversations.untitled);
  const [selected, select] = useState<ArchiveItem>(), [mode, setMode] = useState<"actions" | "confirm">("actions");
  const change = (remove: boolean) => { if (selected) { void archives.change(selected, remove); select(undefined); } };
  return <SettingsScreen title={S.sections.archives} description={S.sectionDescriptions.archives}>
    <SettingsGroup title={S.pageSections.archived}>
      {!archives.view || archives.error ? <GroupInset><LoadState error={archives.error} onRetry={() => void archives.load()} /></GroupInset> : <>
        {items.map(item => <ListRow key={`${item.kind}:${item.id}`} title={item.title} description={`${archiveSubtitle(item, app)} · ${relativeAge(item.updatedAt, app)}`}
          disabled={archives.busy} onPress={() => { setMode("actions"); select(item); }} />)}
        {!items.length ? <GroupInset><Text variant="caption">{app.interfaceDetails.archivesEmpty}</Text></GroupInset> : null}
      </>}
      {archives.view?.pagination.has_more ? <GroupInset><Button label={app.common.more} disabled={archives.busy} onPress={() => void archives.load(items.length)} /></GroupInset> : null}
    </SettingsGroup>
    <Sheet open={Boolean(selected)} onClose={() => select(undefined)} title={mode === "confirm" ? app.common.delete : selected?.title ?? S.sections.archives}
      description={mode === "confirm" && selected ? app.interfaceTemplates.deleteItem(selected.title) : undefined} cancelLabel={M.settings.cancel}
      action={mode === "confirm" ? <Button variant="destructive" label={app.common.delete} disabled={archives.busy} onPress={() => change(true)} /> : undefined}>
      {mode === "actions" ? <>
        {selected?.kind === "session" ? <ListRow title={app.common.open} onPress={() => { select(undefined); router.push({ pathname: "/chat/[id]", params: { id: selected.id, title: selected.title } }); }} /> : null}
        <ListRow title={app.interfaceDetails.unarchive} disabled={archives.busy} onPress={() => change(false)} />
        <ListRow title={app.interfaceDetails.delete} onPress={() => setMode("confirm")} />
      </> : null}
    </Sheet>
  </SettingsScreen>;
}
