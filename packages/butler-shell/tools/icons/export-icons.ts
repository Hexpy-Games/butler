#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Glyph = readonly (readonly [string, Record<string, string | number>])[];
type Source = {
  path: string;
  file: any;
  imports: Map<string, string>;
  constants: Map<string, any>;
  exports: Map<string, any>;
};
type IconExport = { name: string; source: Source; initializer: any };

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../../");
const uiRoot = join(repoRoot, "packages/butler-app/client/ui");
const uiRequire = createRequire(join(uiRoot, "package.json"));
const ts: any = uiRequire("typescript");
const react = uiRequire("react");
const { renderToStaticMarkup } = uiRequire("react-dom/server");
const coreIcons = await loadPackage("@hugeicons/core-free-icons");
const hugeiconsReact = await loadPackage("@hugeicons/react");
const HugeiconsIcon = hugeiconsReact.HugeiconsIcon;
const iconRoot = join(repoRoot, "packages/butler-shell/crates/butler-shell/assets/icons");
const rustRoot = join(repoRoot, "packages/butler-shell/crates/butler-shell/src/ui");
const customAsset = "spinner.svg";
const sources = [
  join(uiRoot, "src/libs/design-system/components/Icons/Icons.tsx"),
  join(uiRoot, "src/libs/design-system/components/Icons/BrowserIcons.tsx"),
].map(readSource);

function packageRoot(name: string): string {
  let dir = dirname(uiRequire.resolve(name));
  while (dir !== dirname(dir)) {
    const path = join(dir, "package.json");
    if (existsSync(path)) {
      const metadata = JSON.parse(readFileSync(path, "utf8"));
      if (metadata.name === name) return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(`Could not locate ${name} from ${uiRoot}`);
}

async function loadPackage(name: string): Promise<any> {
  const root = packageRoot(name);
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return import(pathToFileURL(resolve(root, metadata.module)).href);
}

function readSource(path: string): Source {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (file.parseDiagnostics.length) {
    throw new Error(`Could not parse ${path}: ${file.parseDiagnostics[0].messageText}`);
  }
  const source: Source = {
    path,
    file,
    imports: new Map(),
    constants: new Map(),
    exports: new Map(),
  };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) collectImports(statement, source);
    if (ts.isVariableStatement(statement)) collectVariables(statement, source);
  }
  return source;
}

function collectImports(statement: any, source: Source): void {
  if (statement.moduleSpecifier.text !== "@hugeicons/core-free-icons") return;
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return;
  for (const element of bindings.elements) {
    source.imports.set(element.name.text, (element.propertyName ?? element.name).text);
  }
}

function collectVariables(statement: any, source: Source): void {
  const exported = statement.modifiers?.some(
    (modifier: any) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const name = declaration.name.text;
    source.constants.set(name, declaration.initializer);
    if (exported) source.exports.set(name, declaration.initializer);
  }
}

function unwrap(node: any): any {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function evaluate(node: any, source: Source, stack: Set<string> = new Set()): any {
  node = unwrap(node);
  if (ts.isIdentifier(node)) {
    const imported = source.imports.get(node.text);
    if (imported) {
      const glyph = coreIcons[imported];
      if (!glyph) throw new Error(`Missing Hugeicons glyph ${imported} in ${source.path}`);
      return glyph;
    }
    const initializer = source.constants.get(node.text);
    if (!initializer) throw new Error(`Unknown icon source ${node.text} in ${source.path}`);
    if (stack.has(node.text)) throw new Error(`Cyclic icon source ${node.text} in ${source.path}`);
    const next = new Set(stack);
    next.add(node.text);
    return evaluate(initializer, source, next);
  }
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element: any) =>
      ts.isSpreadElement(element)
        ? evaluate(element.expression, source, stack)
        : [evaluate(element, source, stack)],
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        Object.assign(value, evaluate(property.expression, source, stack));
      } else if (ts.isPropertyAssignment(property)) {
        const name = property.name.text ?? property.name.getText(source.file);
        value[name] = evaluate(property.initializer, source, stack);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        value[property.name.text] = evaluate(property.name, source, stack);
      } else {
        throw new Error(`Unsupported icon object member in ${source.path}`);
      }
    }
    return value;
  }
  if (ts.isElementAccessExpression(node)) {
    return evaluate(node.expression, source, stack)[evaluate(node.argumentExpression, source, stack)];
  }
  if (ts.isPropertyAccessExpression(node)) {
    return evaluate(node.expression, source, stack)[node.name.text];
  }
  throw new Error(`Unsupported icon expression ${node.getText(source.file)} in ${source.path}`);
}

const exports: IconExport[] = sources.flatMap((source) =>
  [...source.exports].map(([name, initializer]) => ({ name, source, initializer })),
);
const exportByName = new Map(exports.map((item) => [item.name, item]));
const resolved = new Map<string, { glyph: Glyph; target: string }>();

function resolveExport(item: IconExport, stack: Set<string> = new Set()): { glyph: Glyph; target: string } {
  const cached = resolved.get(item.name);
  if (cached) return cached;
  if (stack.has(item.name)) throw new Error(`Cyclic DS icon alias ${item.name}`);
  const next = new Set(stack);
  next.add(item.name);
  const initializer = unwrap(item.initializer);
  if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === "createIcon") {
    const glyph = evaluate(initializer.arguments[0], item.source);
    if (!Array.isArray(glyph) || !glyph.every((part) => Array.isArray(part) && typeof part[0] === "string")) {
      throw new Error(`DS export ${item.name} did not resolve to an icon glyph`);
    }
    const result = { glyph: glyph as Glyph, target: item.name };
    resolved.set(item.name, result);
    return result;
  }
  if (ts.isIdentifier(initializer)) {
    const target = exportByName.get(initializer.text);
    if (!target) throw new Error(`DS icon alias ${item.name} targets unknown export ${initializer.text}`);
    const result = resolveExport(target, next);
    resolved.set(item.name, result);
    return result;
  }
  throw new Error(`Unsupported DS icon export ${item.name} in ${item.source.path}`);
}

function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])([0-9])/g, "$1-$2")
    .toLowerCase();
}

function renderSvg(glyph: Glyph): string {
  return `${renderToStaticMarkup(
    react.createElement(HugeiconsIcon, { icon: glyph, size: 24, color: "#000" }),
  )}\n`;
}

function rustSource(direct: IconExport[], aliases: Array<[string, string]>): string {
  const variants = direct.map(({ name }, index) => `    ${name} = ${index},`).join("\n");
  const paths = direct.map(({ name }) => `    "icons/${kebabCase(name)}.svg",`).join("\n");
  const consts = aliases
    .map(([name, target]) => `    pub const ${name}: Self = Self::${target};`)
    .join("\n");
  return [
    "// @generated by tools/icons/export-icons.ts. Do not edit.",
    "#[allow(dead_code, unreachable_pub, clippy::enum_variant_names)]",
    "#[derive(Clone, Copy, Debug, Eq, PartialEq)]",
    "#[repr(usize)]",
    "pub enum Icon {",
    variants,
    "}",
    "",
    "static ICON_PATHS: [&str; " + direct.length + "] = [",
    paths,
    "];",
    "",
    "#[allow(dead_code, non_upper_case_globals, unreachable_pub)]",
    "impl Icon {",
    consts,
    "",
    "    pub fn path(self) -> &'static str {",
    "        ICON_PATHS[self as usize]",
    "    }",
    "}",
    "",
  ].join("\n");
}

function assetSource(direct: IconExport[]): string {
  const rows = direct.map(({ name }) => `    icon!("${kebabCase(name)}"),`);
  rows.push("    // Butler sidebar loading spinner from ui/sidebar/row.rs.", "    icon!(\"spinner\"),");
  return [
    "// @generated by tools/icons/export-icons.ts. Do not edit.",
    "const FILES: &[(&str, &[u8])] = &[",
    ...rows,
    "];",
    "",
  ].join("\n");
}

const direct = exports.filter((item) => resolveExport(item).target === item.name);
const aliases = exports
  .filter((item) => resolveExport(item).target !== item.name)
  .map((item) => [item.name, resolveExport(item).target] as [string, string]);
const generated = new Map<string, string>();
for (const item of direct) {
  generated.set(join(iconRoot, `${kebabCase(item.name)}.svg`), renderSvg(resolveExport(item).glyph));
}
generated.set(join(rustRoot, "icons_generated.rs"), rustSource(direct, aliases));
generated.set(join(rustRoot, "icon_files.rs"), assetSource(direct));

const check = process.argv.includes("--check");
const changed: string[] = [];
for (const [path, content] of generated) {
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) changed.push(path);
}
const outputPaths = new Set(generated.keys());
const staleAssets = readdirSync(iconRoot)
  .filter((name) => name.endsWith(".svg") && name !== customAsset)
  .map((name) => join(iconRoot, name))
  .filter((path) => !outputPaths.has(path));
changed.push(...staleAssets);
if (check) {
  if (changed.length) {
    console.error(`Generated icon files are stale (${changed.length}):`);
    for (const path of changed) console.error(`  ${path}`);
    process.exitCode = 1;
  }
} else {
  mkdirSync(iconRoot, { recursive: true });
  mkdirSync(rustRoot, { recursive: true });
  for (const path of staleAssets) unlinkSync(path);
  for (const [path, content] of generated) writeFileSync(path, content);
  console.log(
    `Generated ${direct.length} glyph files for ${exports.length} DS exports (${aliases.length} aliases).`,
  );
}
