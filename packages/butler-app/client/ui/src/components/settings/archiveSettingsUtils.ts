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
  if (item.kind === "project") return "프로젝트";
  if (item.session.kind !== "project") return "일반 대화";
  return `프로젝트 대화 · ${item.session.project?.display_name ?? item.session.project_id ?? "알 수 없는 프로젝트"}`;
}
