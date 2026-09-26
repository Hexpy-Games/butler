/**
 * DS UNSAFE_style codemod (roadmap S8).
 *
 * Product code may not pass `className` or `style` to design-system
 * components. This codemod renames a `style=` on a DS component to
 * `UNSAFE_style=` when the component offers `UNSAFE_style` and the value is
 * geometry only (width/height/min/max sizes, transform, inset and custom
 * properties). Everything else is reported: a remaining `className` or
 * `style` on a DS component makes the run fail, and tsc reports stragglers
 * the static pass cannot see (spreads, wrappers).
 *
 *   bun run packages/butler-app/scripts/codemods/ds-unsafe-style.ts           # dry run
 *   bun run packages/butler-app/scripts/codemods/ds-unsafe-style.ts --write   # apply
 */
import { join, relative } from "node:path";
import { Node, Project, SyntaxKind, type JsxAttribute, type SourceFile, type Type } from "ts-morph";

export const GEOMETRY_KEYS = new Set([
  "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "transform", "inset",
]);

const root = process.cwd();
const uiRoot = join(root, "packages", "butler-app", "client", "ui");
const sourceRoot = join(uiRoot, "src");
const dsRoot = join(sourceRoot, "libs", "design-system");

export type Finding = { file: string; line: number; tag: string; attribute: string; action: "rename" | "report"; reason: string };

function isDsComponentFile(path: string): boolean {
  return path.startsWith(`${dsRoot}/`) && /\/(components|blocks|shadcn)\//u.test(path)
    && !/\.(showcase|guidance|test)\.tsx?$/u.test(path);
}

/** Product files: the UI source outside the design system and tests. */
function isProductFile(path: string): boolean {
  return path.startsWith(`${sourceRoot}/`) && !path.startsWith(`${dsRoot}/`) && !/\.test\.tsx?$/u.test(path)
    && !path.endsWith(".d.ts");
}

function dsTag(attribute: JsxAttribute): { tag: string; offersUnsafeStyle: boolean } | null {
  const opening = attribute.getParent()?.getParent();
  if (!opening || (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening))) return null;
  const tagNode = opening.getTagNameNode();
  let symbol = tagNode.getSymbol();
  if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
  const declaration = symbol?.getDeclarations()[0];
  if (!declaration || !isDsComponentFile(declaration.getSourceFile().getFilePath())) return null;
  const props = tagNode.getType().getCallSignatures()[0]?.getParameters()[0]?.getTypeAtLocation(tagNode);
  return { tag: tagNode.getText(), offersUnsafeStyle: Boolean(props?.getProperty("UNSAFE_style")) };
}

/** Property names of a style value's type, or null when the shape is open-ended (CSSProperties). */
export function styleKeys(type: Type): string[] | null {
  const keys = type.getApparentProperties().map((property) => property.getName());
  // A declared CSSProperties exposes hundreds of optional keys: the shape is unknown.
  if (keys.length > 40) return null;
  return keys;
}

export function isGeometryOnly(keys: string[]): boolean {
  return keys.every((key) => GEOMETRY_KEYS.has(key) || key.startsWith("--"));
}

export function planFile(sourceFile: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const file = relative(sourceRoot, sourceFile.getFilePath());
  for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    const name = attribute.getNameNode().getText();
    if (name !== "className" && name !== "style") continue;
    const target = dsTag(attribute);
    if (!target) continue;
    const line = attribute.getStartLineNumber();
    if (name === "className") {
      findings.push({ file, line, tag: target.tag, attribute: name, action: "report", reason: "className on a DS component: use its props or add a DS capability" });
      continue;
    }
    const initializer = attribute.getInitializer();
    const expression = initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined;
    const keys = expression ? styleKeys(expression.getType()) : null;
    if (!target.offersUnsafeStyle) {
      findings.push({ file, line, tag: target.tag, attribute: name, action: "report", reason: `<${target.tag}> has no UNSAFE_style: use its props or add a DS capability` });
    } else if (!keys) {
      findings.push({ file, line, tag: target.tag, attribute: name, action: "report", reason: "style shape is open-ended (CSSProperties): type it as UnsafeStyle" });
    } else if (!isGeometryOnly(keys)) {
      const extra = keys.filter((key) => !GEOMETRY_KEYS.has(key) && !key.startsWith("--"));
      findings.push({ file, line, tag: target.tag, attribute: name, action: "report", reason: `non-geometry keys (${extra.join(", ")}): use DS props` });
    } else {
      findings.push({ file, line, tag: target.tag, attribute: name, action: "rename", reason: `geometry only (${keys.join(", ") || "empty"})` });
    }
  }
  return findings;
}

async function main() {
  const write = process.argv.includes("--write");
  const project = new Project({ tsConfigFilePath: join(uiRoot, "tsconfig.json") });
  const findings: Finding[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    if (!isProductFile(sourceFile.getFilePath())) continue;
    const planned = planFile(sourceFile);
    findings.push(...planned);
    if (!write) continue;
    for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute).reverse()) {
      const line = attribute.getStartLineNumber();
      if (attribute.getNameNode().getText() !== "style") continue;
      if (planned.some((finding) => finding.line === line && finding.action === "rename")) attribute.getNameNode().replaceWithText("UNSAFE_style");
    }
  }
  if (write) await project.save();
  const renames = findings.filter((finding) => finding.action === "rename");
  const reports = findings.filter((finding) => finding.action === "report");
  for (const finding of renames) console.log(`${write ? "renamed" : "rename"} ${finding.file}:${finding.line} <${finding.tag}> style -> UNSAFE_style (${finding.reason})`);
  for (const finding of reports) console.error(`FAIL ${finding.file}:${finding.line} <${finding.tag}> ${finding.attribute}: ${finding.reason}`);
  console.log(`${renames.length} geometry style(s) ${write ? "renamed" : "to rename"}, ${reports.length} className/style left on DS components.`);
  if (reports.length > 0 || (!write && renames.length > 0)) process.exit(1);
}

if (import.meta.main) await main();
