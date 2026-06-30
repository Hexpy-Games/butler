import { resolve } from "node:path";
import { BOOLEAN_FLAGS } from "./constants.js";
import { CliError } from "./errors.js";

export function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "body") {
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) {
          options[key] = true;
          continue;
        }
        options[key] = value;
        index += 1;
        continue;
      }
      if (BOOLEAN_FLAGS.has(key)) {
        options[key] = true;
        continue;
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliError(`--${key} requires a value`);
      }
      options[key] = value;
      index += 1;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options };
}

export function projectRoot(options) {
  return resolve(String(options.project ?? process.cwd()));
}

export function requiredOption(options, name) {
  const value = String(options[name] ?? "").trim();
  if (!value) throw new CliError(`--${name} is required`);
  return value;
}

export function optionalString(options, name) {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function optionalNumber(options, name, fallback = null) {
  const value = options[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CliError(`--${name} must be a number`);
  return parsed;
}
