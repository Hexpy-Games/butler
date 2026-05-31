import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const BUTLER_DATA = process.env.BUTLER_DATA || join(homedir(), ".butler");
const TASKS_DIR = join(BUTLER_DATA, "tasks");

export interface TaskInfo {
  taskId: string;
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED" | "UNKNOWN";
  project: string;
  request: string;
  result?: string;
  pid?: string;
}

export async function getTaskResult(taskId: string): Promise<TaskInfo> {
  const taskDir = join(TASKS_DIR, taskId);
  if (!existsSync(taskDir)) {
    return { taskId, status: "UNKNOWN", project: "", request: "" };
  }

  const read = async (file: string) => {
    try {
      return (await readFile(join(taskDir, file), "utf8")).trim();
    } catch {
      return "";
    }
  };

  const status = (await read("status")) as TaskInfo["status"];
  const project = await read("project");
  const request = await read("request.md");
  const result = status === "DONE" || status === "FAILED" ? await read("result.md") : undefined;
  const pid = await read("pid");

  return { taskId, status, project, request, result, pid };
}

export async function listTasks(
  filterStatus?: string,
): Promise<TaskInfo[]> {
  const { readdir } = await import("fs/promises");
  let entries: string[];
  try {
    entries = await readdir(TASKS_DIR);
  } catch {
    return [];
  }

  const tasks = await Promise.all(
    entries.map((id) => getTaskResult(id)),
  );

  if (filterStatus) {
    return tasks.filter((t) => t.status === filterStatus.toUpperCase());
  }
  return tasks.sort((a, b) => b.taskId.localeCompare(a.taskId));
}
