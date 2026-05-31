import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { BUTLER_DIR } from "./constants.ts";

const EXCLUDED_PROJECTS = new Set(["dev", join(homedir(), "dev"), ""]);

export interface RecentTask {
  id: string;
  status: string;
  request: string;
}

export interface ProjectSummary {
  project: string;
  totalTasks: number;
  doneTasks: number;
  failedTasks: number;
  runningTasks: number;
  recentTasks: RecentTask[];
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

export async function listProjects(
  tasksDir: string = BUTLER_DIR.TASKS,
): Promise<ProjectSummary[]> {
  if (!existsSync(tasksDir)) return [];

  const entries = readdirSync(tasksDir, { withFileTypes: true });

  // Collect all tasks grouped by project
  const projectMap = new Map<string, { id: string; status: string; request: string }[]>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = join(tasksDir, entry.name);
    const project = readFile(join(dir, "project"));
    if (!project || EXCLUDED_PROJECTS.has(project)) continue;

    const status = readFile(join(dir, "status"));
    const request = readFile(join(dir, "request.md"));

    if (!projectMap.has(project)) {
      projectMap.set(project, []);
    }
    projectMap.get(project)!.push({ id: entry.name, status, request });
  }

  // Build summaries
  const summaries: ProjectSummary[] = [];

  for (const [project, tasks] of projectMap) {
    // Sort newest first (task IDs are epoch timestamps)
    tasks.sort((a, b) => b.id.localeCompare(a.id));

    const doneTasks = tasks.filter((t) => t.status === "DONE").length;
    const failedTasks = tasks.filter((t) => t.status === "FAILED").length;
    const runningTasks = tasks.filter((t) => t.status === "RUNNING").length;

    summaries.push({
      project,
      totalTasks: tasks.length,
      doneTasks,
      failedTasks,
      runningTasks,
      recentTasks: tasks.slice(0, 3).map((t) => ({
        id: t.id,
        status: t.status,
        request: t.request,
      })),
    });
  }

  // Sort by most recent task
  summaries.sort((a, b) => {
    const aLatest = a.recentTasks[0]?.id ?? "0";
    const bLatest = b.recentTasks[0]?.id ?? "0";
    return bLatest.localeCompare(aLatest);
  });

  return summaries;
}
