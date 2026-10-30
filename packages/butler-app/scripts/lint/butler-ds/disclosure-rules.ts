import type { Rule } from "eslint";

// Loose JSX/TS AST node shape; ESLint's ESTree types do not model JSX or TS nodes.
type Node = { type: string; [key: string]: any };

/** The disclosure glyphs: right (closed) and down (open). */
const CHEVRONS = new Set(["ChevronRight", "ChevronRightIcon", "ChevronDown", "ChevronDownIcon"]);
/** Props that place their node before the element's label. */
const START_ICON_PROPS = new Set(["icon", "iconStart", "startIcon", "leading", "leadingIcon"]);

function hasAttribute(opening: Node, name: string): boolean {
  return opening.attributes.some((attr: Node) =>
    attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === name);
}

function isBlankText(node: Node): boolean {
  return node.type === "JSXText" && node.value.trim() === "";
}

function firstChild(node: Node): Node | undefined {
  return node.children.find((child: Node) => !isBlankText(child));
}

/**
 * Whether the node is, or starts with, a disclosure chevron: a chevron
 * element, a wrapper whose first child leads with one, or a conditional of
 * those. A wrapper with the title first and the chevron after it does not.
 */
function leadsWithChevron(node: Node | null | undefined): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.type === "JSXElement") {
    const name = node.openingElement.name;
    if (name.type === "JSXIdentifier" && CHEVRONS.has(name.name)) return true;
    return leadsWithChevron(firstChild(node));
  }
  if (node.type === "JSXFragment") return leadsWithChevron(firstChild(node));
  if (node.type === "JSXExpressionContainer") return leadsWithChevron(node.expression);
  if (node.type === "ConditionalExpression") return leadsWithChevron(node.consequent) || leadsWithChevron(node.alternate);
  if (node.type === "LogicalExpression") return leadsWithChevron(node.left) || leadsWithChevron(node.right);
  return false;
}

/**
 * A disclosure chevron never leads a title: it sits directly right of the
 * title text. Flags a toggle (an element with aria-expanded) whose first
 * child is or contains a chevron, or that gets one through a start-icon prop.
 */
const noLeadingDisclosureChevron: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "A disclosure chevron never comes before the title; it follows the title text." },
    schema: [],
    messages: {
      leadingChild:
        "A disclosure chevron leads this toggle's label; put it directly right of the title (DisclosureRow does), never before it.",
      startIconProp:
        "A disclosure chevron passed as {{prop}} leads this toggle's label; put it directly right of the title, never before it.",
    },
  },
  create(context) {
    return {
      JSXElement(node: any) {
        const opening = node.openingElement;
        if (!hasAttribute(opening, "aria-expanded")) return;
        if (leadsWithChevron(firstChild(node))) context.report({ node: opening, messageId: "leadingChild" });
        for (const attr of opening.attributes) {
          if (attr.type !== "JSXAttribute" || attr.name.type !== "JSXIdentifier" || !START_ICON_PROPS.has(attr.name.name)) continue;
          if (leadsWithChevron(attr.value)) context.report({ node: attr, messageId: "startIconProp", data: { prop: attr.name.name } });
        }
      },
    };
  },
};

export const disclosureEslintRules = { "no-leading-disclosure-chevron": noLeadingDisclosureChevron };
