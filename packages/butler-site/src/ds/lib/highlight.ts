/**
 * Build-time code highlighting mapped to the DS syntax tokens. Shiki runs with
 * a CSS-variables theme; the transformer turns each token color into a
 * `data-syntax` role (the app's MarkdownCodeFrame contract) so CodeFrame CSS
 * colors it with --syntax-* and no inline styles reach the page.
 */
import { createCssVariablesTheme, type ShikiTransformer } from "shiki";

const PREFIX = "--shiki-";

export const syntaxTheme = createCssVariablesTheme({ name: "butler-syntax", variablePrefix: PREFIX, fontStyle: false });

/** Shiki css-variables token -> DS syntax role (--syntax-<role>). */
export const SYNTAX_ROLE: Record<string, string> = {
  "token-keyword": "keyword",
  "token-string": "string",
  "token-string-expression": "string",
  "token-link": "string",
  "token-comment": "comment",
  "token-constant": "number",
  "token-function": "title",
  "token-parameter": "variable",
  "token-punctuation": "meta",
  "token-changed": "meta",
  "token-inserted": "addition",
  "token-deleted": "deletion",
};

const VARIABLE = new RegExp(`var\\(${PREFIX}([\\w-]+)`, "u");

export const syntaxRoleTransformer: ShikiTransformer = {
  name: "butler-syntax-roles",
  pre(node) {
    delete node.properties.style;
    delete node.properties.class;
  },
  span(node) {
    const style = node.properties.style;
    const variable = typeof style === "string" ? VARIABLE.exec(style)?.[1] : undefined;
    delete node.properties.style;
    const role = variable ? SYNTAX_ROLE[variable] : undefined;
    if (role) node.properties["data-syntax"] = role;
  },
};
