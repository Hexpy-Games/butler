import { join } from "path";

function trimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function cognitionRoot(butlerData: string): string {
  return trimmedEnv("BUTLER_COGNITION_HOME") ?? join(butlerData, "cognition");
}

export function cognitionMemoryRoot(butlerData: string): string {
  return trimmedEnv("BUTLER_COGNITION_MEMORY_HOME") ?? join(cognitionRoot(butlerData), "memory");
}

export function cognitionBoxRoot(butlerData: string): string {
  return join(cognitionRoot(butlerData), "box");
}

export function cognitionFeedbackRoot(butlerData: string): string {
  return join(cognitionRoot(butlerData), "feedback");
}

export function cognitionConsolidationRoot(butlerData: string): string {
  return join(cognitionRoot(butlerData), "consolidation");
}

export function cognitionKnowHowRoot(butlerData: string): string {
  return join(cognitionRoot(butlerData), "know-how");
}

export function cognitionMigrationRoot(butlerData: string): string {
  return join(cognitionRoot(butlerData), "migration");
}
