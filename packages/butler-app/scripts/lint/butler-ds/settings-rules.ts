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
/** Section kinds whose header may hold actions: lists (add, refresh, filter) and live status (refresh, period). */
const ACTION_KINDS = new Set(["list", "status"]);
/** DS controls that edit a setting (imported directly or through a product re-export); a section header never holds one (filters and periods use Select or SegmentedControl). */
const SETTING_CONTROLS = new Set(["Input", "Textarea", "Switch", "Slider", "Checkbox", "NativeSelect", "SettingsField", "SettingsActionField"]);
/** Button sizes a section header action may use: small, with or without a label. */
const HEADER_BUTTON_SIZES = new Set(["sm", "icon-sm"]);
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

/** The DS component `name` exported by a product `file` re-exports (`export { SettingsSection } from "@/butler-ds"`), if any. */
function reexportedDsName(file: string, name: string, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  for (const [, specifiers, source] of readFileSync(file, "utf8").matchAll(REEXPORT)) {
    const entry = specifiers!.split(",").map((part) => part.trim().split(/\s+as\s+/u))
      .find((parts) => (parts[1] ?? parts[0]) === name);
    if (!entry) continue;
    if (isDesignSystemSource(source!)) return entry[0];
    const module = resolveModule(file, source!);
    return module ? reexportedDsName(module, entry[0]!, depth + 1) : undefined;
  }
  return undefined;
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

/** Every JSX element anywhere inside a node (attribute values, children, nested expressions). */
function jsxElementsWithin(node: unknown, found: Node[] = []): Node[] {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const item of node) jsxElementsWithin(item, found);
    return found;
  }
  const value = node as Node;
  if (value.type === "JSXElement") found.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (key !== "parent" && key !== "loc" && key !== "range") jsxElementsWithin(child, found);
  }
  return found;
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

/** A section header holds only small outline actions, never a setting, and only on list and status sections. */
function checkHeaderActions(context: Rule.RuleContext, opening: Node, actions: Node, dsName: (name: string) => string | undefined) {
  if (!ACTION_KINDS.has(String(literalValue(attribute(opening, "kind"))))) {
    context.report({ node: opening as any, messageId: "headerAction" });
  }
  for (const element of jsxElementsWithin(actions.value)) {
    const control = rootName(element.openingElement.name);
    const ds = element.openingElement.name.type === "JSXIdentifier" ? dsName(control) : undefined;
    if (ds && SETTING_CONTROLS.has(ds)) {
      context.report({ node: element.openingElement, messageId: "headerSetting", data: { control } });
    } else if (ds === "IconButton" || ds === "Button" && (literalValue(attribute(element.openingElement, "variant")) !== "outline"
      || !HEADER_BUTTON_SIZES.has(String(literalValue(attribute(element.openingElement, "size")))))) {
      context.report({ node: element.openingElement, messageId: "headerButton" });
    }
  }
}

const settingsFieldGrouping: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Settings fields and sections take their spacing from the DS; section headers hold only small outline actions on list and status sections." },
    schema: [],
    messages: {
      gapWrapper:
        "<{{wrapper}}> spaces <{{child}}> with its own gap; render fields directly in the section card and sections directly in the SettingsPage (they own the field and section gaps), and put a field's status in its meta slot.",
      headerAction:
        "Section header actions belong to list and status sections (kind=\"list\" or \"status\"); put this action in a SettingsActionField row with a description.",
      headerSetting:
        "<{{control}}> edits a setting; a section header holds only actions (add, refresh, filter, period). Put the setting in the card as a SettingsField.",
      headerButton:
        "Section header buttons are outline and small: Button variant=\"outline\" size=\"sm\" (or size=\"icon-sm\"), not IconButton.",
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
    /** DS name of a JSX element: imported from the DS directly or through a product re-export. */
    const dsName = (name: string): string | undefined => {
      if (dsNames.has(name)) return name;
      const source = productImports.get(name);
      const module = source ? resolveModule(context.filename, source) : undefined;
      return module ? reexportedDsName(module, name) : undefined;
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
        const actions = SETTINGS_SECTIONS.has(dsName(name) ?? "") ? attribute(opening, "actions") : undefined;
        if (actions) checkHeaderActions(context, opening, actions, dsName);
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
