export const SUCCESSOR_DOMAIN_PATHS = [
  "packages/butler-agent/src/agent/adapters",
  "packages/butler-agent/src/agent/btcc",
  "packages/butler-agent/src/agent/composition",
  "packages/butler-agent/src/agent/conversation",
  "packages/butler-agent/src/agent/work-ledger",
] as const;

export const SUCCESSOR_TEST_PATHS = [
  "tests/contracts/btcc",
  "tests/e2e/btcc",
  "tests/faults/btcc",
  "tests/integration/btcc",
  "tests/unit/btcc",
] as const;

export const LEGACY_DOMAIN_PATHS = [
  "packages/butler-agent/src/agent/turn",
  "packages/butler-agent/src/agent/work",
] as const;

export const SOURCE_BASELINE_COMMIT = "98bd40f6a2d66ab7cb1ae03baea6345accd8e110";
export const MAX_PHYSICAL_LINES = 350;

export type SourceShapeFindingCode =
  | "cross_domain_deep_import"
  | "explicit_api_missing"
  | "legacy_dependency"
  | "line_limit_exceeded"
  | "public_index_missing"
  | "wildcard_export";

export type SourceShapeFinding = {
  code: SourceShapeFindingCode;
  path: string;
  message: string;
};

export type MaterializedDomain = {
  name: string;
  path: string;
  indexPath: string;
};

export type DiscoveredSuccessorSources = {
  domains: MaterializedDomain[];
  changedDomainPaths: string[];
  changedFilePaths: string[];
  filePaths: string[];
};

export type ModuleReference = {
  kind: "dynamic-import" | "export" | "import" | "require";
  specifier: string;
  resolvedPath?: string;
};

export type ParsedTypeScriptModule = {
  path: string;
  physicalLines: number;
  references: ModuleReference[];
  hasExplicitExport: boolean;
  hasWildcardExport: boolean;
};

export type SourceShapeReport = {
  inspectedDomains: number;
  inspectedFiles: number;
  findings: SourceShapeFinding[];
};
