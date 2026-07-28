import type {
  ActiveProjectLedgerReference,
} from "./active-project-ledger-reference.ts";
import {
  ActiveProjectLedgerResolver,
} from "./active-project-ledger-reference.ts";
import { runProjectLedgerTool } from "./client.ts";

type ProjectLedgerLookup = {
  appMessageDbPath?: string;
  appProjectId?: string;
  explicitRef?: string;
};

export function ensureActiveProjectLedger(input: {
  resolver: ActiveProjectLedgerResolver;
  butlerHome: string;
  butlerData: string;
  lookup: ProjectLedgerLookup;
}): ActiveProjectLedgerReference {
  let reference = resolveReference(input);
  if (reference.initialized) return reference;

  const initialized = runProjectLedgerTool(
    { butlerHome: input.butlerHome, butlerData: input.butlerData },
    [
      "init",
      "--project",
      reference.workspace_path,
      "--id",
      reference.app_project_id,
      "--name",
      reference.display_name ?? reference.ledger_project_id,
    ],
  );
  if (initialized.ok === false) {
    throw new Error(projectLedgerInitializationFailure(initialized));
  }

  input.resolver.clear();
  reference = resolveReference(input);
  if (!reference.initialized) {
    throw new Error("Project Ledger initialization did not publish its canonical root");
  }
  return reference;
}

function resolveReference(input: {
  resolver: ActiveProjectLedgerResolver;
  butlerData: string;
  lookup: ProjectLedgerLookup;
}): ActiveProjectLedgerReference {
  return input.resolver.resolve({
    butlerData: input.butlerData,
    ...input.lookup,
  });
}

function projectLedgerInitializationFailure(
  result: Record<string, unknown>,
): string {
  const error = result.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return "Project Ledger initialization failed";
  }
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code
    ? `Project Ledger initialization failed: ${code}`
    : "Project Ledger initialization failed";
}
