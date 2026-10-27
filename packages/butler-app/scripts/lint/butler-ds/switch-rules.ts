import type { Rule } from "eslint";

// Loose JSX/TS AST node shape; ESLint's ESTree types do not model JSX or TS nodes.
type Node = { type: string; [key: string]: any };

const DS_IMPORT = /^@\/butler-ds(?:\/|$)|(?:^|\/)libs\/design-system(?:\/|$)/u;
/** Text that names the switch beside it: a label or any Typo variant. */
const LABELS = new Set(["Label", "FieldLabel", "Typo"]);

function rootName(name: Node): string {
  let root = name;
  while (root.type === "JSXMemberExpression") root = root.object;
  return root.type === "JSXIdentifier" ? root.name : "";
}

function literalAttribute(element: Node, name: string): string | undefined {
  const attr = element.attributes.find((node: Node) => node.type === "JSXAttribute" && node.name.name === name);
  const value = attr?.value?.type === "JSXExpressionContainer" ? attr.value.expression : attr?.value;
  return value?.type === "Literal" ? String(value.value) : undefined;
}

/** A switch field stacks like an input; the row layout goes through Field orientation="horizontal". */
const switchFieldLayout: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "A Switch never sits beside its label in a Stack or Inline row; switch fields use Field." },
    schema: [],
    messages: {
      rowSwitchField:
        "<{{wrapper}}> puts a Switch beside its label. A switch field stacks like an input (Field: label, description, switch); the row layout is Field orientation=\"horizontal\", only on a phone or for a list item in a card.",
    },
  },
  create(context) {
    const dsNames = new Set<string>();
    return {
      ImportDeclaration(node: any) {
        if (node.importKind === "type" || !DS_IMPORT.test(String(node.source.value))) return;
        for (const specifier of node.specifiers) dsNames.add(specifier.local.name);
      },
      JSXElement(node: any) {
        const opening = node.openingElement;
        if (opening.name.type !== "JSXIdentifier" || !dsNames.has(opening.name.name)) return;
        const wrapper = opening.name.name;
        const row = wrapper === "Inline" || (wrapper === "Stack" && literalAttribute(opening, "align") === "row");
        if (!row) return;
        const children = node.children.filter((child: Node) => child.type === "JSXElement")
          .map((child: Node) => rootName(child.openingElement.name)).filter((name: string) => dsNames.has(name));
        if (children.includes("Switch") && children.some((name: string) => LABELS.has(name))) {
          context.report({ node: opening, messageId: "rowSwitchField", data: { wrapper } });
        }
      },
    };
  },
};

export const switchEslintRules = { "switch-field-layout": switchFieldLayout };
