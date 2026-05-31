import { homedir } from "os";
import { join } from "path";

export interface CommonCliOptions {
  home: string;
  data: string;
  json: boolean;
  verbose: boolean;
  quiet: boolean;
  yes: boolean;
  nonInteractive: boolean;
  help: boolean;
}

export interface ParsedCommonOptions {
  args: string[];
  options: CommonCliOptions;
  errors: string[];
}

export interface CommonOptionDefaults {
  home?: string;
  data?: string;
  homeDir?: string;
}

export function expandHome(value: string | undefined, homeDir = homedir()): string | undefined {
  if (!value) return value;
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

export function parseCommonOptions(
  rawArgs: string[],
  defaults: CommonOptionDefaults = {},
): ParsedCommonOptions {
  const homeDir = defaults.homeDir ?? homedir();
  const args: string[] = [];
  const errors: string[] = [];
  const options: CommonCliOptions = {
    home: expandHome(defaults.home ?? process.env.BUTLER_HOME ?? "~/butler", homeDir) ?? "",
    data: expandHome(defaults.data ?? process.env.BUTLER_DATA ?? "~/.butler", homeDir) ?? "",
    json: false,
    verbose: false,
    quiet: false,
    yes: false,
    nonInteractive: false,
    help: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "--home") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        errors.push("--home requires a path");
      } else {
        options.home = expandHome(value, homeDir) ?? options.home;
        index += 1;
      }
    } else if (arg === "--data") {
      const value = rawArgs[index + 1];
      if (!value || value.startsWith("--")) {
        errors.push("--data requires a path");
      } else {
        options.data = expandHome(value, homeDir) ?? options.data;
        index += 1;
      }
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--quiet" || arg === "--silent") {
      options.quiet = true;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--non-interactive") {
      options.nonInteractive = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      args.push(arg);
    }
  }

  return { args, options, errors };
}
