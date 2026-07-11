import { butlerAgentResourcesPath } from "../../../runtime/paths.ts";
import { cognitionMemoryRoot } from "../../../agent/cognition/paths.ts";
import { existsSync, readFileSync } from "fs";
import { getButlerData, getButlerHome } from "../shared/runtime-support.ts";
import { join } from "path";



export function loadFileIfExists(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}



export function buildWorkerInstructions(): string {
  const butlerHome = getButlerHome();
  const core = loadFileIfExists(butlerAgentResourcesPath(butlerHome, "prompts", "runtime-system-contract.md"));
  const worker = loadFileIfExists(butlerAgentResourcesPath(butlerHome, "prompts", "worker.md"));
  const toolContract = [
    "## Tool Contract",
    "- You have one tool named `run_shell`.",
    "- Commands execute in a non-interactive bash shell rooted at the assigned project path.",
    "- Prefer `rg` / `rg --files` for search and `sed`, `head`, `tail`, `cat` for inspection.",
    "- For config, manifest, script, log, or code searches based on user wording, prefer structured extraction or case-insensitive search before concluding absence.",
    "- You do not have a dedicated patch-edit tool. Make precise file edits with shell commands only.",
    "- Prefer targeted edits over full-file rewrites when the file is large or easy to corrupt.",
    "- Run tests and checks yourself before finishing whenever the task touches code.",
    "- Batch read-only discovery into a small number of targeted commands. Avoid broad repository scans, vendor trees, and repeated overlapping file slices.",
    "- Once the task acceptance criteria can be answered from collected evidence, stop calling tools and compose the worker report.",
  ].join("\n");

  return [core, worker, toolContract].filter(Boolean).join("\n\n");
}



export function buildWorkerMemoryContextInstruction(): string {
  const butlerData = getButlerData();
  const memoryRoot = cognitionMemoryRoot(butlerData);
  const candidates = [
    join(memoryRoot, "core.md"),
    join(memoryRoot, "hot", "cache.md"),
    join(butlerData, "personas", "active.md"),
    join(butlerData, "eol.md"),
  ].filter((path) => existsSync(path));

  if (candidates.length === 0) {
    return [
      "No Butler memory context files are currently present.",
      "Do not fail the task because memory context is absent; proceed from the task description and project files.",
    ].join("\n");
  }

  return [
    "Optional Butler memory context files are available.",
    "Read only the files that are relevant to the task; if any file is missing or unreadable, continue without failing the task.",
    ...candidates.map((path) => `- ${path}`),
  ].join("\n");
}
