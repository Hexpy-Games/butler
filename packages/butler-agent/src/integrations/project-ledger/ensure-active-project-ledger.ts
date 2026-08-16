import type {
  ActiveProjectLedgerReference,
} from "./active-project-ledger-reference.ts";
import {
  ActiveProjectLedgerResolver,
} from "./active-project-ledger-reference.ts";
import { canonicalRootFromExplicit } from
  "./active-project-ledger-paths.ts";
import { runProjectLedgerTool } from "./client.ts";
import { resolve } from "node:path";

type ProjectLedgerLookup = {
  appProjectId?: string;
  workspacePath?: string;
  explicitRef?: string;
};

export function ensureActiveProjectLedger(input: {
  resolver: ActiveProjectLedgerResolver;
  butlerHome: string;
  butlerData: string;
  lookup: ProjectLedgerLookup;
  reference?: ActiveProjectLedgerReference;
}): ActiveProjectLedgerReference {
  const reference = validateCapturedReference(
    input,
    input.reference ?? resolveReference(input),
  );
  if (reference.initialized) return reference;

  const initialized = runProjectLedgerTool(
    { butlerHome: input.butlerHome, butlerData: input.butlerData },
    [
      "init",
      "--project",
      reference.ledger_root,
      "--id",
      reference.ledger_project_id,
      "--name",
      reference.display_name ?? reference.ledger_project_id,
    ],
  );
  if (initialized.ok === false) {
    throw new Error(projectLedgerInitializationFailure(initialized));
  }

  input.resolver.clear();
  const initializedReference = input.resolver.resolve({
    butlerData: input.butlerData,
    appProjectId: reference.app_project_id,
    explicitRef: reference.ledger_root,
  });
  if (
    initializedReference.ledger_root !== reference.ledger_root ||
    !initializedReference.initialized
  ) {
    throw new Error("Project Ledger initialization did not publish its canonical root");
  }
  return withCapturedPresentation(initializedReference, reference);
}

function validateCapturedReference(
  input: {
    resolver: ActiveProjectLedgerResolver;
    butlerData: string;
  },
  reference: ActiveProjectLedgerReference,
): ActiveProjectLedgerReference {
  const projectsRoot = resolve(input.butlerData, "project-ledger", "projects");
  const canonical = canonicalRootFromExplicit(
    projectsRoot,
    reference.ledger_root,
  );
  if (
    !canonical ||
    canonical.root !== resolve(reference.ledger_root) ||
    canonical.id !== reference.ledger_project_id
  ) {
    throw new Error("Project Ledger identity changed before initialization");
  }
  input.resolver.clear();
  const validated = input.resolver.resolve({
    butlerData: input.butlerData,
    appProjectId: reference.app_project_id,
    explicitRef: canonical.root,
  });
  if (
    validated.ledger_root !== canonical.root ||
    validated.ledger_project_id !== canonical.id
  ) {
    throw new Error("Project Ledger identity changed before initialization");
  }
  return withCapturedPresentation(validated, reference);
}

function withCapturedPresentation(
  validated: ActiveProjectLedgerReference,
  captured: ActiveProjectLedgerReference,
): ActiveProjectLedgerReference {
  return {
    ...validated,
    app_project_id: captured.app_project_id,
    workspace_path: captured.workspace_path,
    ...(captured.workspace_label
      ? { workspace_label: captured.workspace_label }
      : {}),
    ...(captured.display_name ? { display_name: captured.display_name } : {}),
    source: captured.source,
    ...(captured.degradation_code
      ? { degradation_code: captured.degradation_code }
      : {}),
    ...(captured.ambiguity_count
      ? { ambiguity_count: captured.ambiguity_count }
      : {}),
  };
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
