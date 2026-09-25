import type { Rule } from "eslint";

// Loose JSX/TS AST node shape; ESLint's ESTree types do not model JSX or TS nodes.
type Node = { type: string; [key: string]: any };

const DS_IMPORT = /^@\/butler-ds(?:\/|$)|^@\/libs\/design-system(?:\/|$)|(?:^|\/)libs\/design-system(?:\/|$)/u;

export function isDesignSystemImport(source: string): boolean {
  return DS_IMPORT.test(source);
}

function jsxName(name: Node): string {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return `${jsxName(name.object)}.${name.property.name}`;
  if (name.type === "JSXNamespacedName") return `${name.namespace.name}:${name.name.name}`;
  return "";
}

function attribute(element: Node, name: string): Node | undefined {
  return element.attributes.find((attr: Node) =>
    attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === name);
}

function staticAttributeValue(attr: Node | undefined): string | undefined {
  if (!attr?.value) return undefined;
  if (attr.value.type === "Literal") return String(attr.value.value);
  const expression = attr.value.expression;
  if (attr.value.type === "JSXExpressionContainer" && expression?.type === "Literal") return String(expression.value);
  return undefined;
}

function rule(description: string, messages: Record<string, string>, create: Rule.RuleModule["create"]): Rule.RuleModule {
  return { meta: { type: "problem", docs: { description }, schema: [], messages }, create };
}

const noClassNameOnDs = rule(
  "Product code must not pass className to design-system components.",
  {
    classNameOnDs:
      "Do not pass className to design-system component <{{name}}>; use its props or request a DS capability.",
  },
  (context) => {
    const dsNames = new Set<string>();
    return {
      ImportDeclaration(node: any) {
        if (!isDesignSystemImport(String(node.source.value))) return;
        for (const specifier of node.specifiers) dsNames.add(specifier.local.name);
      },
      JSXOpeningElement(node: any) {
        let root: Node = node.name;
        while (root.type === "JSXMemberExpression") root = root.object;
        if (root.type !== "JSXIdentifier" || !dsNames.has(root.name)) return;
        const className = attribute(node, "className");
        if (className) context.report({ node: className as any, messageId: "classNameOnDs", data: { name: jsxName(node.name) } });
      },
    };
  },
);

const STYLE_ONLY_KEYS = new Set([
  "backgroundColor",
  "borderColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
]);

function isCssPropertiesType(type: Node | undefined): boolean {
  if (type?.type !== "TSTypeReference") return false;
  const name = type.typeName;
  if (name.type === "Identifier") return name.name === "CSSProperties";
  return name.type === "TSQualifiedName" && name.right.name === "CSSProperties";
}

const noInlineStyle = rule(
  "Product code must not use inline styles or CSSProperties style objects.",
  {
    styleProp: "Do not use the style prop in product code; use DS props or tokens (UNSAFE_style is reserved for approved escapes).",
    styleObject: "Do not build CSSProperties or color/font style objects in product code; use DS props or tokens.",
  },
  (context) => ({
    JSXAttribute(node: any) {
      if (node.name.type === "JSXIdentifier" && node.name.name === "style") context.report({ node, messageId: "styleProp" });
    },
    VariableDeclarator(node: any) {
      if (isCssPropertiesType(node.id.typeAnnotation?.typeAnnotation)) context.report({ node, messageId: "styleObject" });
    },
    "TSAsExpression, TSSatisfiesExpression"(node: any) {
      if (isCssPropertiesType(node.typeAnnotation)) context.report({ node, messageId: "styleObject" });
    },
    ObjectExpression(node: any) {
      const parent = (node as { parent?: Node }).parent;
      if (parent?.type === "JSXExpressionContainer") return;
      if (parent?.type === "VariableDeclarator" && isCssPropertiesType(parent.id.typeAnnotation?.typeAnnotation)) return;
      if (parent?.type === "TSAsExpression" || parent?.type === "TSSatisfiesExpression") {
        if (isCssPropertiesType(parent.typeAnnotation)) return;
      }
      const styled = node.properties.some((property: Node) =>
        property.type === "Property" && property.key.type === "Identifier" && STYLE_ONLY_KEYS.has(property.key.name));
      if (styled) context.report({ node, messageId: "styleObject" });
    },
  }),
);

const RAW_INTERACTIVE = new Set(["button", "input", "select", "textarea"]);
// Input types without a DS primitive stay allowed.
const INPUT_TYPES_WITHOUT_DS = new Set(["file", "hidden"]);

const noRawInteractive = rule(
  "Product code must use DS interactive primitives instead of raw controls.",
  {
    rawInteractive: "Use the design-system primitive instead of a raw <{{tag}}> (Button, IconButton, Input, Select, NativeSelect, Textarea, Switch, Slider).",
    anchorButton: "An <a> with onClick and no href is a button; use a DS Button or Clickable.",
  },
  (context) => ({
    JSXOpeningElement(node: any) {
      if (node.name.type !== "JSXIdentifier") return;
      const tag = node.name.name;
      if (tag === "a") {
        if (attribute(node, "onClick") && !attribute(node, "href")) context.report({ node, messageId: "anchorButton" });
        return;
      }
      if (!RAW_INTERACTIVE.has(tag)) return;
      if (tag === "input" && INPUT_TYPES_WITHOUT_DS.has(staticAttributeValue(attribute(node, "type")) ?? "")) return;
      context.report({ node, messageId: "rawInteractive", data: { tag } });
    },
  }),
);

const TYPOGRAPHY_TAGS = /^(?:p|span|h[1-6])$/u;

const noRawTypography = rule(
  "Product code must use Typo instead of styled raw text elements.",
  {
    rawTypography: "Styled raw <{{tag}}> text; use a Typo variant instead of className on text elements.",
  },
  (context) => ({
    JSXOpeningElement(node: any) {
      if (node.name.type !== "JSXIdentifier" || !TYPOGRAPHY_TAGS.test(node.name.name)) return;
      if (attribute(node, "className")) context.report({ node, messageId: "rawTypography", data: { tag: node.name.name } });
    },
  }),
);

export const butlerDsEslintPlugin = {
  meta: { name: "butler-ds" },
  rules: {
    "no-classname-on-ds": noClassNameOnDs,
    "no-inline-style": noInlineStyle,
    "no-raw-interactive": noRawInteractive,
    "no-raw-typography": noRawTypography,
  },
};
