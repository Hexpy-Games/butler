import { appCopy } from "@/app/copy.ts";
import type {
  ArchiveListView,
  ProjectSummary,
  SessionSummary,
} from "@/app/types.ts";

export type ArchiveItem =
  | {
      kind: "project";
      id: string;
      title: string;
      updatedAt: string;
      project: ProjectSummary;
    }
  | {
      kind: "session";
      id: string;
      title: string;
      updatedAt: string;
      session: SessionSummary;
    };

export function archiveItems(archives: ArchiveListView | null): ArchiveItem[] {
  if (!archives) return [];
  return [
    ...archives.projects.map(
      (project): ArchiveItem => ({
        kind: "project",
        id: project.id,
        title: project.display_name,
        updatedAt: project.last_activity_at,
        project,
      }),
    ),
    ...archives.sessions.map(
      (session): ArchiveItem => ({
        kind: "session",
        id: session.id,
        title: session.title,
        updatedAt: session.last_activity_at,
        session,
      }),
    ),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function archiveSubtitle(item: ArchiveItem): string {
  if (item.kind === "project") return appCopy.interfaceDetails.project;
  if (item.session.kind !== "project") return appCopy.interfaceDetails.generalConversation;
  return appCopy.interfaceTemplates.projectConversation(item.session.project?.display_name ?? item.session.project_id ?? appCopy.interfaceDetails.unknownProject);
}
