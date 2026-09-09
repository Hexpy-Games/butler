import { createContext, useContext } from "react";
import type { DashboardStatisticsView } from "../../../../../../butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";

export const ProjectStatisticsContext = createContext<{
  data: DashboardStatisticsView; openSource: (key: string) => void;
} | null>(null);

export function useProjectStatistics() {
  const context = useContext(ProjectStatisticsContext);
  if (!context) throw new Error("Project statistics context missing");
  return context;
}
