import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { rememberDashboardLoadedCount, useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, ButtonContainer, ChevronRight, FileText, IconButton, MessageSquarePlus, NavRow, Pin, Notice, Section, Stack, Typo } from "@/butler-ds";
import styles from "./ProjectInformation.module.css";
import type { DashboardArtifactPage } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import { notifyError } from "@/app/notifications.ts";
import { useProjectArtifactAttachment } from "@/hooks/useProjectArtifactAttachment.ts";
import type { ProjectDashboardDocument } from "@/app/types.ts";

export function ProjectResultsPanel({ projectId, preferences, onUpdated, onSelect }: { projectId: string;
  preferences?: { revision: number; pinnedSourceRefs: Array<{ kind: string; id: string; revision: string }> };
  onUpdated?: () => void;
  onSelect: (source: ProjectDashboardDocument) => void;
}) {
  const locale = useAppLocale();
  const attach = useProjectArtifactAttachment(projectId);
  const [page, setPage] = useState<DashboardArtifactPage | null>(null);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pinned = (id: string) => preferences?.pinnedSourceRefs.some((ref) => ref.kind === "artifact" && ref.id === id) ?? false;
  const togglePin = async (item: DashboardArtifactPage["items"][number]) => {
    if (!preferences) return;
    const pins = pinned(item.id) ? preferences.pinnedSourceRefs.filter((ref) => ref.kind !== "artifact" || ref.id !== item.id)
      : [...preferences.pinnedSourceRefs, { kind: "artifact", id: item.id, revision: item.revision }];
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/dashboard/preferences`, {
        method: "PATCH", body: JSON.stringify({ expectedRevision: preferences.revision, pinnedSourceRefs: pins }),
      });
      onUpdated?.();
    } catch (error) { notifyError(error, appCopy.feedback.dashboardRetry); }
  };
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(false);
    const query = new URLSearchParams({ limit: "8", ...(cursor ? { cursor } : {}) });
    const request = async () => {
      let next = await api<DashboardArtifactPage>(`/projects/${encodeURIComponent(projectId)}/dashboard/artifacts?${query}`);
      const wanted = useProjectDashboardState.getState().projects[projectId]?.loadedCounts?.results ?? 8;
      while (!cursor && !cancelled && next.nextCursor && next.items.length < wanted) {
        query.set("cursor", next.nextCursor);
        const more = await api<DashboardArtifactPage>(`/projects/${encodeURIComponent(projectId)}/dashboard/artifacts?${query}`);
        next = { ...more, items: [...next.items, ...more.items] };
      }
      return next;
    };
    request()
      .then((next) => { if (!cancelled) setPage((old) => cursor && old ? { ...next, items: [...old.items, ...next.items] } : next); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, cursor, attempt]);
  useEffect(() => {
    if (page) rememberDashboardLoadedCount(projectId, "results", page.items.length);
  }, [page, projectId]);
  return <Section title={appCopy.projectSignpost.results}>
    <Stack gap="md">
      {error && <Notice tone="error" message={appCopy.feedback.dashboardRetry} action={<Button variant="outline"
        onClick={() => { setCursor(undefined); setPage(null); setAttempt((value) => value + 1); }}>{appCopy.feedback.retry}</Button>} />}
      {!page && loading && <Typo.Body role="status">{appCopy.feedback.dashboardLoading}</Typo.Body>}
      {!!page?.items.length && <div className={styles.rows}>{page.items.map((item) => <NavRow key={`${item.message_id}:${item.file_id}`}
        icon={<FileText />} label={<span className={styles.title}>{item.title}</span>} multiline
        meta={<Typo.Caption className={styles.summary}>{item.session_title} · {new Date(item.created_at).toLocaleDateString(locale)}</Typo.Caption>}
        onClick={() => onSelect({ id: item.id, project_id: projectId, revision: item.revision,
          document_type: "artifact", kind: "report", title: item.title, markdown: "", safe_path_label: item.title, updated_at: item.created_at })}
        actions={<ButtonContainer size="sm">
          <IconButton label={appCopy.projectSignpost.addToComposer} onClick={(event) => { event.stopPropagation(); void attach({ id: item.id, revision: item.revision }); }}><MessageSquarePlus /></IconButton>
          {preferences && <IconButton label={pinned(item.id) ? appCopy.projectSignpost.unpin : appCopy.projectSignpost.pin}
            onClick={(event) => { event.stopPropagation(); void togglePin(item); }}><Pin /></IconButton>}
          <ChevronRight />
        </ButtonContainer>} />)}</div>}
      {page?.items.length === 0 && <Typo.Body>{appCopy.projectSignpost.noResults}</Typo.Body>}
      {page?.nextCursor && <Button variant="borderless" disabled={loading} onClick={() => setCursor(page.nextCursor!)}>{appCopy.projectSignpost.loadMore}</Button>}
    </Stack>
  </Section>;
}
