import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { ChevronRight, DisclosureRow, FileText, NavRow, Stack, Typo } from "@/butler-ds";
import type { ProjectDashboardDocument } from "@/app/types.ts";
import type { DashboardBriefingView } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import styles from "./ProjectInformation.module.css";

export function ProjectSourceLinks({ ids, briefing, projectId, onSelect, coverage = false }: {
  ids: string[]; briefing: DashboardBriefingView; projectId: string;
  onSelect: (document: ProjectDashboardDocument) => void; coverage?: boolean;
}) {
  useAppLocale();
  const [open, setOpen] = useState(false);
  const copy = appCopy.projectSignpost;
  const scope = briefing.coverage;
  return <DisclosureRow surface="plain" title={copy.evidenceCount(ids.length)} open={open} onToggle={() => setOpen(!open)}>
    <Stack gap="sm">
      {ids.map((id) => {
        const item = briefing.sources.find((source) => source.sourceId === id);
        return item && <NavRow key={id} icon={<FileText />} multiline
          label={<span className={styles.title}>{item.title}</span>} actions={<ChevronRight />}
          onClick={() => onSelect({ id: item.id, project_id: projectId, revision: item.revision,
            kind: item.kind === "spec" ? "spec" : item.kind === "report" ? "report" : "plan",
            document_type: item.kind, title: item.title, markdown: "", safe_path_label: item.id, updated_at: "" })} />;
      })}
      {coverage && <Typo.Caption>{copy.summarized} · {copy.briefingCoverage(scope.includedWorks, scope.totalWorks,
        scope.includedDocuments, scope.includedReports, scope.excludedUnits)}</Typo.Caption>}
    </Stack>
  </DisclosureRow>;
}
