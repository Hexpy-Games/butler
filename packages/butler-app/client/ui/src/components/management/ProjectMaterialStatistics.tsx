import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { SegmentedControl, Stack, Typo } from "@/butler-ds";
import { useProjectStatistics } from "./projectStatisticsContext.ts";
import { ProjectStatisticChart } from "./ProjectStatisticChart.tsx";

export function ProjectMaterialStatistics() {
  useAppLocale();
  const { data } = useProjectStatistics();
  const [mode, setMode] = useState("types");
  const copy = appCopy.projectStatistics;
  return <Stack gap="sm">
    <ProjectStatisticChart key={mode} title={copy.materials} description={copy.materialsHelp}
      series={mode === "types" ? data.materialTypes : data.materials} stacked
      actions={<SegmentedControl size="sm" ariaLabel={appCopy.projectSignpost.materialsView} value={mode} onValueChange={setMode}
        options={[{ value: "types", label: copy.labels.types }, { value: "changes", label: copy.labels.changes }]} />} />
    {!data.ledgerHistoryAvailable && <Typo.Caption>{copy.historyUnavailable}</Typo.Caption>}
    {!data.sessionHistoryAvailable && <Typo.Caption>{copy.sessionUnavailable}</Typo.Caption>}
  </Stack>;
}
