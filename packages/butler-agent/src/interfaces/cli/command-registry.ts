import commandData from "./commands.json";

export type CommandPriority = "core" | "operator" | "advanced" | "deferred";
export type CommandStatus = "implemented" | "planned" | "deferred";

export interface ButlerCliCommand {
  id: string;
  path: string[];
  usage: string;
  priority: CommandPriority;
  status: CommandStatus;
  implemented: boolean;
  supportsJson: boolean;
  summary: string;
  spec: string;
  aliases?: string[];
}

export interface CommandListOptions {
  implementedOnly?: boolean;
  includeDeferred?: boolean;
}

export const COMMANDS = commandData as ButlerCliCommand[];

export function listCommands(options: CommandListOptions = {}): ButlerCliCommand[] {
  return COMMANDS.filter((command) => {
    if (options.implementedOnly && !command.implemented) return false;
    if (options.includeDeferred === false && command.priority === "deferred") return false;
    return true;
  });
}

export function findCommand(path: string[]): ButlerCliCommand | null {
  const exact = COMMANDS.find((command) => {
    if (command.path.length !== path.length) return false;
    return command.path.every((part, index) => part === path[index]);
  });

  return exact ?? null;
}

export function commandDisplayPath(command: ButlerCliCommand): string {
  return `butler ${command.path.join(" ")}`;
}

export function commandPriorityLabel(priority: CommandPriority): string {
  switch (priority) {
    case "core":
      return "Core";
    case "operator":
      return "Operator";
    case "advanced":
      return "Advanced";
    case "deferred":
      return "Deferred";
  }
}
