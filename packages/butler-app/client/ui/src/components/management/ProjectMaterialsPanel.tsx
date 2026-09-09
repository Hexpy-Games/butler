import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { rememberDashboardLoadedCount, useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import { projectDocumentBadgeLabel } from "@/app/projectDocuments.ts";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import { Button, ButtonContainer, ChevronRight, FileText, IconButton, Pin, NavRow, Notice, Section, Stack, Typo } from "@/butler-ds";
import styles from "./ProjectInformation.module.css";
import type { DashboardMaterialsPage } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";

export function ProjectMaterialsPanel({ projectId, onSelect, preferences, onUpdated, limit = 8, onShowAll }: {
  projectId: string; onSelect: (document: ProjectDashboardDocument) => void;
  preferences?: { revision: number; pinnedSourceRefs: Array<{ kind: string; id: string; revision: string }> };
  onUpdated?: () => void; limit?: number; onShowAll?: () => void;
}) {
  const locale = useAppLocale();
  const [page, setPage] = useState<DashboardMaterialsPage | null>(null);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    setLoading(true);
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}), ...(onShowAll ? { important: "true" } : {}) });
    const request = async () => {
      let next = await api<DashboardMaterialsPage>(`/projects/${encodeURIComponent(projectId)}/dashboard/materials?${query}`);
      const wanted = useProjectDashboardState.getState().projects[projectId]?.loadedCounts?.materials ?? limit;
      while (!onShowAll && !cursor && !cancelled && next.status === "ready" && next.nextCursor && next.documents.length < wanted) {
        query.set("cursor", next.nextCursor);
        const more = await api<DashboardMaterialsPage>(`/projects/${encodeURIComponent(projectId)}/dashboard/materials?${query}`);
        next = more.status === "ready" ? { ...more, documents: [...next.documents, ...more.documents] } : more;
      }
      return next;
    };
    request()
      .then((next) => { if (!cancelled) setPage((old) => cursor && old?.status === "ready" && next.status === "ready"
        ? { ...next, documents: [...old.documents, ...next.documents] } : next); })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, cursor, limit, preferences?.revision, attempt]);
  useEffect(() => {
    if (!onShowAll && page?.status === "ready") rememberDashboardLoadedCount(projectId, "materials", page.documents.length);
  }, [page, projectId, Boolean(onShowAll)]);
  const isPinned = (document: ProjectDashboardDocument) => preferences?.pinnedSourceRefs.some((ref) =>
    ref.id === document.id && ref.kind === (document.document_type ?? document.kind)) ?? false;
  const togglePin = async (document: ProjectDashboardDocument) => {
    if (!preferences || !document.revision) return;
    const ref = { kind: document.document_type ?? document.kind, id: document.id, revision: document.revision };
    const pins = isPinned(document) ? preferences.pinnedSourceRefs.filter((pin) => pin.id !== ref.id || pin.kind !== ref.kind)
      : [...preferences.pinnedSourceRefs, ref];
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/dashboard/preferences`, {
        method: "PATCH", body: JSON.stringify({ expectedRevision: preferences.revision, pinnedSourceRefs: pins }),
      });
      onUpdated?.();
    } catch (error) { notifyError(error, appCopy.feedback.dashboardRetry); }
  };
  if (error) return <Notice tone="error" message={appCopy.feedback.dashboardRetry} action={<Button variant="outline"
    onClick={() => { setCursor(undefined); setPage(null); setAttempt((value) => value + 1); }}>{appCopy.feedback.retry}</Button>} />;
  if (!page) return <Typo.Body role="status">{appCopy.feedback.dashboardLoading}</Typo.Body>;
  if (page.status === "unavailable") return <Typo.Body>{appCopy.projectSignpost.unavailable}</Typo.Body>;
  const groups = onShowAll ? [{ title: "", documents: page.documents }] : [
    { title: appCopy.projectSignpost.importantMaterials, documents: page.documents.filter(isPinned) },
    { title: appCopy.projectSignpost.projectDocuments, documents: page.documents.filter((document) => !isPinned(document)) },
  ];
  return <Stack gap="xl">
    {groups.filter((group) => group.documents.length > 0).map((group) => <Section key={group.title} title={group.title || undefined}>
      <div className={styles.rows}>{group.documents.map((document) => <NavRow key={`${document.document_type}:${document.id}`} multiline icon={<FileText />}
        label={<span className={styles.title}>{document.unavailable ? appCopy.projectSignpost.missingSource : document.title}</span>}
        meta={<Typo.Caption className={styles.summary}>{[projectDocumentBadgeLabel(document), document.updated_at && new Date(document.updated_at).toLocaleDateString(locale)].filter(Boolean).join(" · ")}</Typo.Caption>}
        disabled={document.unavailable} onClick={() => onSelect(document)} actions={<ButtonContainer size="sm">
          {preferences && !onShowAll && <IconButton label={isPinned(document) ? appCopy.projectSignpost.unpin : appCopy.projectSignpost.pin}
            onClick={(event) => { event.stopPropagation(); void togglePin(document); }}><Pin /></IconButton>}
          <ChevronRight />
        </ButtonContainer>} />)}</div>
    </Section>)}
    {page.documents.length === 0 && <Typo.Body>{appCopy.interfaceDetails.noDocuments}</Typo.Body>}
    {page.nextCursor && <Button variant="borderless" disabled={loading} onClick={onShowAll ?? (() => setCursor(page.nextCursor!))}>{appCopy.projectSignpost.loadMore}</Button>}
  </Stack>;
}
