import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Tabs, TabsList, TabsTrigger, Stack, Typo } from "@/butler-ds";
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
      actions={<Tabs value={mode} onValueChange={setMode}><TabsList>
        <TabsTrigger value="types">{copy.labels.types}</TabsTrigger>
        <TabsTrigger value="changes">{copy.labels.changes}</TabsTrigger>
      </TabsList></Tabs>} />
    {!data.ledgerHistoryAvailable && <Typo.Caption>{copy.historyUnavailable}</Typo.Caption>}
    {!data.sessionHistoryAvailable && <Typo.Caption>{copy.sessionUnavailable}</Typo.Caption>}
  </Stack>;
}
