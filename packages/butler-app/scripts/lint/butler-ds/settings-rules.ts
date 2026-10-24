import type { Rule } from "eslint";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Loose JSX/TS AST node shape; ESLint's ESTree types do not model JSX or TS nodes.
type Node = { type: string; [key: string]: any };

/** DS blocks that own settings spacing: fields (the card's field gap) and sections (the page's section gap). */
const DS_SETTINGS = new Set(["SettingsField", "SettingsActionField", "SettingsFieldGroup", "SettingsSection", "FormSection"]);
const DS_SETTINGS_TAG = /<(?:SettingsField|SettingsActionField|SettingsFieldGroup|SettingsSection|FormSection)\b/u;
/** DS layout primitives that space their children (Stack, Inline and Grid default to a gap). */
const DS_GAP_WRAPPERS = new Set(["Stack", "Inline", "Grid"]);
const SETTINGS_SECTIONS = new Set(["SettingsSection", "FormSection"]);
const IMPORT = /^import\s+(?!type\b)\{([^}]*)\}\s+from\s+"([^"]+)";?$/gmu;

function isDesignSystemSource(source: string): boolean {
  return /^@\/butler-ds(?:\/|$)|(?:^|\/)libs\/design-system(?:\/|$)/u.test(source);
}

/** Module file of a relative or `@/` import, or undefined (packages, the DS, unresolved). */
function resolveModule(fromFile: string, source: string): string | undefined {
  if (isDesignSystemSource(source)) return undefined;
  const srcRoot = fromFile.includes("/client/ui/src/") ? `${fromFile.slice(0, fromFile.indexOf("/client/ui/src/"))}/client/ui/src` : undefined;
  const base = source.startsWith(".") ? resolve(dirname(fromFile), source)
    : source.startsWith("@/") && srcRoot ? join(srcRoot, source.slice(2)) : undefined;
  if (!base) return undefined;
  const stripped = base.replace(/\.tsx?$/u, "");
  return [`${stripped}.tsx`, `${stripped}.ts`, `${stripped}/index.tsx`, `${stripped}/index.ts`].find((path) => existsSync(path));
}

/** Named imports of a module source text: local name -> import source. */
function namedImports(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const [, specifiers, source] of text.matchAll(IMPORT)) {
    for (const specifier of specifiers!.split(",")) {
      const local = specifier.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u).pop()?.trim();
      if (local && /^[A-Z]/u.test(local)) names.set(local, source!);
    }
  }
  return names;
}

const REEXPORT = /^export\s+\{([^}]*)\}\s+from\s+"([^"]+)";?$/gmu;

/** Whether `name` exported by `file` renders a settings field or section, following `export { name } from`. */
function exportRendersSettings(file: string, name: string, visiting = new Set<string>()): boolean {
  for (const [, specifiers, source] of readFileSync(file, "utf8").matchAll(REEXPORT)) {
    const entry = specifiers!.split(",").map((part) => part.trim().split(/\s+as\s+/u))
      .find((parts) => (parts[1] ?? parts[0]) === name);
    if (!entry) continue;
    if (isDesignSystemSource(source!)) return DS_SETTINGS.has(entry[0]!);
    const module = resolveModule(file, source!);
    return module ? exportRendersSettings(module, entry[0]!, visiting) : false;
  }
  return moduleRendersSettings(file, visiting);
}

const rendersSettingsCache = new Map<string, boolean>();

/** Whether a product module renders a settings field or section, itself or through a component it imports. */
function moduleRendersSettings(file: string, visiting = new Set<string>()): boolean {
  const cached = rendersSettingsCache.get(file);
  if (cached !== undefined) return cached;
  if (visiting.has(file)) return false;
  visiting.add(file);
  const text = readFileSync(file, "utf8");
  let result = DS_SETTINGS_TAG.test(text);
  if (!result) {
    for (const [name, source] of namedImports(text)) {
      if (!new RegExp(`<${name}\\b`, "u").test(text)) continue;
      const module = resolveModule(file, source);
      if (module && exportRendersSettings(module, name, visiting)) { result = true; break; }
    }
  }
  rendersSettingsCache.set(file, result);
  return result;
}

function rootName(name: Node): string {
  let root = name;
  while (root.type === "JSXMemberExpression") root = root.object;
  return root.type === "JSXIdentifier" ? root.name : "";
}

function attribute(element: Node, name: string): Node | undefined {
  return element.attributes.find((attr: Node) =>
    attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === name);
}

function literalValue(attr: Node | undefined): unknown {
  if (attr?.value?.type === "Literal") return attr.value.value;
  return attr?.value?.expression?.type === "Literal" ? attr.value.expression.value : undefined;
}

/** JSX elements a child expression renders: through fragments, `&&`, ternaries and `.map` callbacks. */
function renderedElements(node: Node | null | undefined): Node[] {
  if (!node) return [];
  switch (node.type) {
    case "JSXElement": return [node];
    case "JSXFragment": return node.children.flatMap(renderedElements);
    case "JSXExpressionContainer": return renderedElements(node.expression);
    case "LogicalExpression": return renderedElements(node.right);
    case "ConditionalExpression": return [...renderedElements(node.consequent), ...renderedElements(node.alternate)];
    case "CallExpression": {
      const callback = node.arguments[0];
      if (node.callee.type !== "MemberExpression" || node.callee.property.name !== "map") return [];
      if (callback?.type !== "ArrowFunctionExpression") return [];
      if (callback.body.type !== "BlockStatement") return renderedElements(callback.body);
      return callback.body.body.filter((statement: Node) => statement.type === "ReturnStatement")
        .flatMap((statement: Node) => renderedElements(statement.argument));
    }
    default: return [];
  }
}

const settingsFieldGrouping: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Settings fields and sections take their spacing from the DS; section header actions are list toolbars." },
    schema: [],
    messages: {
      gapWrapper:
        "<{{wrapper}}> spaces <{{child}}> with its own gap; render fields directly in the section card and sections directly in the SettingsPage (they own the field and section gaps), and put a field's status in its meta slot.",
      headerAction:
        "Section header actions are list toolbars (kind=\"list\"); put this action in a SettingsActionField row with a description.",
    },
  },
  create(context) {
    const dsNames = new Set<string>();
    const productImports = new Map<string, string>();
    const rendersSettings = (element: Node): string | undefined => {
      const name = rootName(element.openingElement.name);
      if (dsNames.has(name)) return DS_SETTINGS.has(name) ? name : undefined;
      const source = productImports.get(name);
      const module = source ? resolveModule(context.filename, source) : undefined;
      return module && exportRendersSettings(module, name) ? name : undefined;
    };
    return {
      ImportDeclaration(node: any) {
        if (node.importKind === "type") return;
        const source = String(node.source.value);
        for (const specifier of node.specifiers) {
          if (isDesignSystemSource(source)) dsNames.add(specifier.local.name);
          else productImports.set(specifier.local.name, source);
        }
      },
      JSXElement(node: any) {
        const opening = node.openingElement;
        const name = rootName(opening.name);
        if (SETTINGS_SECTIONS.has(name) && dsNames.has(name) && attribute(opening, "actions")
          && literalValue(attribute(opening, "kind")) !== "list") {
          context.report({ node: opening, messageId: "headerAction" });
        }
        const gap = attribute(opening, "gap");
        // `Stack.Item` is a flex item, not a spaced container: match the full element name.
        const wrapper = opening.name.type === "JSXIdentifier" && dsNames.has(name) && DS_GAP_WRAPPERS.has(name);
        const spaced = wrapper ? literalValue(gap) !== "none" : Boolean(gap);
        if (!spaced) return;
        const child = node.children.flatMap(renderedElements).map(rendersSettings).find(Boolean);
        if (child) context.report({ node: opening, messageId: "gapWrapper", data: { wrapper: name, child } });
      },
    };
  },
};

export const settingsEslintRules = { "settings-field-grouping": settingsFieldGrouping };
