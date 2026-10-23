import type { ProjectDashboardDocument } from "@/app/types.ts";
import { CanonBoard } from "../canon/CanonBoard.tsx";
export function ProjectWorkBoard({ projectId, onOpenSession }: {
  projectId: string; onOpenSession: (id: string) => void;
  revision?: string; onSelect: (document: ProjectDashboardDocument) => void;
}) {
  return <CanonBoard key={projectId} projectId={projectId} onOpenSession={onOpenSession} />;
}
