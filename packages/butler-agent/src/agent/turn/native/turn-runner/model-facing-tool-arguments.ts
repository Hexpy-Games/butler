import { isAbsolute, relative, resolve, sep } from "node:path";
import type { EmbeddedWorkBlockCall } from "./work-block-tool.ts";

const FILE_PATH_TOOLS = new Set(["read_file", "write_file"]);

export function bindRuntimeOwnedWorkspaceArguments(
  call: EmbeddedWorkBlockCall,
  workspacePath: string,
): EmbeddedWorkBlockCall {
  const args = { ...call.args };
  delete args.workspace_root;
  if (FILE_PATH_TOOLS.has(call.name)) {
    args.path = workspaceRelativeValue(args.path, workspacePath);
  }
  if (call.name === "run_command") {
    if ("cwd" in args) args.cwd = workspaceRelativeValue(args.cwd, workspacePath);
    if (Array.isArray(args.output_paths)) {
      args.output_paths = args.output_paths.map((value) =>
        workspaceRelativeValue(value, workspacePath));
    }
  }
  return { ...call, args };
}

function workspaceRelativeValue(value: unknown, workspacePath: string): unknown {
  if (typeof value !== "string" || !isAbsolute(value)) return value;
  for (const root of workspaceAliases(workspacePath)) {
    if (value === root) return ".";
    if (value.startsWith(`${root}${sep}`)) return relative(root, value) || ".";
  }
  return value;
}

function workspaceAliases(workspacePath: string): string[] {
  const configured = resolve(workspacePath);
  const aliases = new Set([configured]);
  if (configured.startsWith("/private/")) aliases.add(configured.slice("/private".length));
  else if (configured.startsWith("/var/") || configured.startsWith("/tmp/")) {
    aliases.add(`/private${configured}`);
  }
  return [...aliases];
}
