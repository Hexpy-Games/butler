import { useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, Section, Stack, Typo } from "@/butler-ds";
import { useComposerStore } from "@/components/conversation/composerStore.ts";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import type { DashboardBriefingView, DashboardBriefingSource } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import { ProjectSourceLinks } from "./ProjectSourceLinks.tsx";
import styles from "./ProjectInformation.module.css";

export function ProjectBriefingPanel({ projectId, briefing, onSelect, onUpdated, section = "position" }: {
  projectId: string; briefing?: DashboardBriefingView; onSelect: (source: ProjectDashboardDocument) => void;
  onUpdated: () => void;
  section?: "position" | "suggestions";
}) {
  useAppLocale();
  const attempted = useRef(new Set<string>());
  const [requestState, setRequestState] = useState<{ revision: string; status: "generating" | "unavailable" } | null>(null);
  const copy = appCopy.projectSignpost;
  const revision = briefing?.sourceRevision;
  const request = async (retry: boolean) => {
    if (!briefing) return;
    const requested = briefing.sourceRevision;
    attempted.current.add(requested); setRequestState({ revision: requested, status: "generating" });
    try {
      const next = await api<DashboardBriefingView>(`/projects/${encodeURIComponent(projectId)}/dashboard/briefing`, {
        method: "POST", body: JSON.stringify({ sourceRevision: requested, retry }),
      });
      setRequestState({ revision: requested, status: next.status === "generating" ? "generating" : "unavailable" });
      onUpdated();
    } catch { setRequestState({ revision: requested, status: "unavailable" }); }
  };
  useEffect(() => {
    if (section !== "position" || briefing?.status !== "needed" || attempted.current.has(briefing.sourceRevision) || document.visibilityState === "hidden") return;
    void request(false);
  }, [revision, briefing?.status, section]);
  if (!briefing) return null;
  const status = briefing.status === "needed" && requestState && requestState.revision === revision ? requestState.status : briefing.status;
  const source = (id: string) => briefing.sources.find((item) => item.sourceId === id);
  const documentFor = (item: DashboardBriefingSource): ProjectDashboardDocument => ({ id: item.id, project_id: projectId,
    revision: item.revision, kind: item.kind === "spec" ? "spec" : item.kind === "report" ? "report" : "plan",
    document_type: item.kind, title: item.title, markdown: "", safe_path_label: item.id, updated_at: "" });
  return <Stack gap="xl">
    {section === "position" && <Section title={copy.position}>
      {status === "ready" && briefing.content ? <Stack gap="sm">
        <Typo.H3>{briefing.content.position.title}</Typo.H3>
        <Typo.Body className={styles.summary}>{briefing.content.position.body}</Typo.Body>
        <ProjectSourceLinks ids={briefing.content.position.sourceIds} briefing={briefing} projectId={projectId} onSelect={onSelect} coverage />
      </Stack> : <Stack gap="sm"><Typo.Body role="status">{status === "unavailable" ? copy.briefingUnavailable : copy.briefingPending}</Typo.Body>
        {status === "unavailable" && briefing.sources.length > 0 && <Button variant="outline" onClick={() => void request(true)}>{appCopy.feedback.retry}</Button>}
      </Stack>}
    </Section>}
    {section === "suggestions" && status === "ready" && briefing.content && briefing.content.suggestions.length > 0 && <Section title={copy.suggestions}>
      <Stack gap="lg">{briefing.content.suggestions.map((item) => <Stack key={item.candidateId} gap="sm" className={styles.suggestion}>
        <Typo.Body>{item.title}</Typo.Body><Typo.Caption className={styles.summary}>{item.reason}</Typo.Caption>
        <Button variant="outline" onClick={() => {
          const candidate = briefing.candidates.find((candidate) => candidate.id === item.candidateId);
          const selected = candidate && source(candidate.sourceId);
          if (!selected) return;
          const composer = useComposerStore.getState();
          if (!composer.text.trim()) composer.setText(`${item.title}\n${item.reason}\n`);
          void composer.addProjectDocument(documentFor(selected));
        }}>{copy.addToComposer}</Button>
        <ProjectSourceLinks ids={item.sourceIds} briefing={briefing} projectId={projectId} onSelect={onSelect} />
      </Stack>)}</Stack>
    </Section>}
  </Stack>;
}
