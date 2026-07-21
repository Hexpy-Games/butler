import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  LEGACY_DOMAIN_PATHS,
  type ModuleReference,
  type ParsedTypeScriptModule,
} from "./contracts.ts";

function compilerOptions(repositoryRoot: string): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
  };
  const configPath = join(repositoryRoot, "tsconfig.json");
  if (!existsSync(configPath)) return defaults;

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }

  const converted = ts.convertCompilerOptionsFromJson(
    config.config.compilerOptions ?? {},
    repositoryRoot,
  );
  if (converted.errors.length > 0) {
    throw new Error(converted.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
      .join("\n"));
  }
  return { ...defaults, ...converted.options };
}

function resolveReference(
  specifier: string,
  sourcePath: string,
  options: ts.CompilerOptions,
): string | undefined {
  return ts.resolveModuleName(specifier, sourcePath, options, ts.sys)
    .resolvedModule?.resolvedFileName;
}

function physicalLineCount(source: string): number {
  if (source.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lines += 1;
    else if (source[index] === "\r" && source[index + 1] !== "\n") lines += 1;
  }
  const lastCharacter = source[source.length - 1];
  return lastCharacter === "\n" || lastCharacter === "\r" ? lines : lines + 1;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ));
}

function hasNamedDeclaration(node: ts.Node): boolean {
  return "name" in node && Boolean((node as ts.NamedDeclaration).name);
}

export function parseTypeScriptModules(
  repositoryRoot: string,
  filePaths: readonly string[],
): ParsedTypeScriptModule[] {
  const options = compilerOptions(repositoryRoot);
  const root = resolve(repositoryRoot);
  const legacyRoots = LEGACY_DOMAIN_PATHS.map((path) => resolve(root, path));
  const pending = [...filePaths];
  const parsed = new Map<string, ParsedTypeScriptModule>();

  const isRepositoryDependency = (path: string): boolean => {
    const pathFromRoot = relative(root, path);
    return pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !pathFromRoot.split(sep).includes("node_modules")
      && !legacyRoots.some((legacyRoot) => {
        const pathFromLegacy = relative(legacyRoot, path);
        return pathFromLegacy === ""
          || (!pathFromLegacy.startsWith(`..${sep}`) && pathFromLegacy !== "..");
      })
      && [".cts", ".mts", ".ts", ".tsx"].some((extension) => path.endsWith(extension));
  };

  while (pending.length > 0) {
    const path = resolve(pending.shift()!);
    if (parsed.has(path)) continue;
    const source = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const references: ModuleReference[] = [];
    let hasExplicitExport = false;
    let hasWildcardExport = false;

    const addReference = (
      kind: ModuleReference["kind"],
      literal: ts.StringLiteralLike,
    ): void => {
      references.push({
        kind,
        specifier: literal.text,
        resolvedPath: resolveReference(literal.text, path, options),
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        addReference("import", node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node)) {
        if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
          hasWildcardExport = true;
        }
        if (node.exportClause
          && ((ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0)
            || ts.isNamespaceExport(node.exportClause))) {
          hasExplicitExport = true;
        }
        if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
          addReference("export", node.moduleSpecifier);
        }
      } else if (ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression
        && ts.isStringLiteralLike(node.moduleReference.expression)) {
        addReference("require", node.moduleReference.expression);
      } else if (ts.isCallExpression(node)
        && node.arguments.length === 1
        && ts.isStringLiteralLike(node.arguments[0])) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          addReference("dynamic-import", node.arguments[0]);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          addReference("require", node.arguments[0]);
        }
      }

      if (node.parent === sourceFile && hasExportModifier(node) && hasNamedDeclaration(node)) {
        hasExplicitExport = true;
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    const module = {
      path,
      physicalLines: physicalLineCount(source),
      references,
      hasExplicitExport,
      hasWildcardExport,
    };
    parsed.set(path, module);
    for (const reference of references) {
      if (reference.resolvedPath && isRepositoryDependency(reference.resolvedPath)) {
        pending.push(reference.resolvedPath);
      }
    }
  }

  return [...parsed.values()].sort((left, right) => left.path.localeCompare(right.path));
}
