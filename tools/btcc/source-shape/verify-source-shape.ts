import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  LEGACY_DOMAIN_PATHS,
  MAX_PHYSICAL_LINES,
  SUCCESSOR_DOMAIN_PATHS,
  SUCCESSOR_TEST_PATHS,
  type MaterializedDomain,
  type ParsedTypeScriptModule,
  type SourceShapeFinding,
  type SourceShapeReport,
} from "./contracts.ts";
import {
  discoverChangedSuccessorModules,
} from "./discover-successor-modules.ts";
import { parseTypeScriptModules } from "./parse-typescript-modules.ts";

function containsPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function owningDomain(
  path: string,
  domains: readonly MaterializedDomain[],
): MaterializedDomain | undefined {
  return domains.find((domain) => containsPath(domain.path, path));
}

function displayPath(repositoryRoot: string, path: string): string {
  return relative(repositoryRoot, path) || ".";
}

function isPublicDomainBoundary(
  sourceDomain: MaterializedDomain,
  targetDomain: MaterializedDomain,
  targetPath: string,
): boolean {
  if (resolve(targetPath) === resolve(targetDomain.indexPath)) return true;
  const pathWithinTarget = relative(targetDomain.path, targetPath);
  if (pathWithinTarget !== "index.ts"
    && pathWithinTarget.endsWith(`${sep}index.ts`)
    && !pathWithinTarget.startsWith(`..${sep}`)) {
    return true;
  }
  return sourceDomain.name === "adapters"
    && targetDomain.name === "btcc"
    && resolve(targetPath) === resolve(targetDomain.path, "gateway-api.ts");
}

function verifyDomainPublicApis(
  repositoryRoot: string,
  domains: readonly MaterializedDomain[],
  modulesByPath: ReadonlyMap<string, ParsedTypeScriptModule>,
): SourceShapeFinding[] {
  return domains.flatMap((domain): SourceShapeFinding[] => {
    const indexPath = displayPath(repositoryRoot, domain.indexPath);
    if (!existsSync(domain.indexPath)) {
      return [{
        code: "public_index_missing",
        path: indexPath,
        message: `${domain.name} must expose its public API through index.ts`,
      }];
    }
    if (!modulesByPath.get(domain.indexPath)?.hasExplicitExport) {
      return [{
        code: "explicit_api_missing",
        path: indexPath,
        message: `${domain.name}/index.ts must explicitly name at least one export`,
      }];
    }
    return [];
  });
}

function verifyModule(
  repositoryRoot: string,
  legacyRoots: readonly string[],
  successorRoots: readonly string[],
  changedFilePaths: ReadonlySet<string>,
  domains: readonly MaterializedDomain[],
  module: ParsedTypeScriptModule,
): SourceShapeFinding[] {
  const path = displayPath(repositoryRoot, module.path);
  const findings: SourceShapeFinding[] = [];
  const isChangedSuccessorFile = changedFilePaths.has(module.path)
    && successorRoots.some((root) => containsPath(root, module.path));

  if (isChangedSuccessorFile && module.physicalLines > MAX_PHYSICAL_LINES) {
    findings.push({
      code: "line_limit_exceeded",
      path,
      message: `${module.physicalLines} physical lines exceeds the ${MAX_PHYSICAL_LINES}-line limit`,
    });
  }
  if (isChangedSuccessorFile && module.hasWildcardExport) {
    findings.push({
      code: "wildcard_export",
      path,
      message: "public surfaces must use explicitly named exports instead of export *",
    });
  }

  const sourceDomain = owningDomain(module.path, domains);
  for (const reference of module.references) {
    if (!reference.resolvedPath) continue;
    const targetPath = reference.resolvedPath;

    if (legacyRoots.some((legacyRoot) => containsPath(legacyRoot, targetPath))) {
      findings.push({
        code: "legacy_dependency",
        path,
        message: `${reference.kind} ${JSON.stringify(reference.specifier)} resolves into legacy BTCC`,
      });
    }

    const targetDomain = owningDomain(targetPath, domains);
    if (isChangedSuccessorFile
      && sourceDomain
      && targetDomain
      && sourceDomain.path !== targetDomain.path
      && existsSync(targetDomain.indexPath)
      && !isPublicDomainBoundary(sourceDomain, targetDomain, targetPath)) {
      findings.push({
        code: "cross_domain_deep_import",
        path,
        message: `${sourceDomain.name} must import ${targetDomain.name} through its index.ts`,
      });
    }
  }

  return findings;
}

export function inspectBtccSourceShape(repositoryRoot: string): SourceShapeReport {
  const discovered = discoverChangedSuccessorModules(repositoryRoot);
  return verifyDiscoveredSuccessorShape(repositoryRoot, discovered);
}

export function verifyDiscoveredSuccessorShape(
  repositoryRoot: string,
  discovered: ReturnType<typeof discoverChangedSuccessorModules>,
): SourceShapeReport {
  const root = resolve(repositoryRoot);
  const modules = parseTypeScriptModules(root, discovered.filePaths);
  const modulesByPath = new Map(modules.map((module) => [module.path, module]));
  const legacyRoots = LEGACY_DOMAIN_PATHS.map((path) => resolve(root, path));
  const successorRoots = [...SUCCESSOR_DOMAIN_PATHS, ...SUCCESSOR_TEST_PATHS]
    .map((path) => resolve(root, path));
  const changedFilePaths = new Set(discovered.changedFilePaths.map((path) => resolve(path)));
  const changedDomains = discovered.domains.filter((domain) =>
    discovered.changedDomainPaths.includes(domain.path));
  const findings = [
    ...verifyDomainPublicApis(root, changedDomains, modulesByPath),
    ...modules.flatMap((module) => verifyModule(
      root,
      legacyRoots,
      successorRoots,
      changedFilePaths,
      discovered.domains,
      module,
    )),
  ].sort((left, right) => left.path.localeCompare(right.path)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message));

  return {
    inspectedDomains: changedDomains.length,
    inspectedFiles: modules.length,
    findings,
  };
}
