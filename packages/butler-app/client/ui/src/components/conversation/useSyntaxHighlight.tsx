import { createElement, useEffect, useState, type ReactNode } from "react";

type Lowlight = typeof import("./syntaxHighlighter").lowlight;
// hast types come through lowlight: "hast" is not a direct dependency, so a
// bare import does not resolve under bun's isolated install.
type Root = ReturnType<Lowlight["highlight"]>;
type ElementContent = Exclude<Root["children"][number], { type: "doctype" }>;

let lowlightPromise: Promise<Lowlight> | null = null;

function loadLowlight(): Promise<Lowlight> {
  lowlightPromise ??= import("./syntaxHighlighter").then((module) => module.lowlight);
  return lowlightPromise;
}

const SYNTAX_ROLES: Record<string, string> = {
  keyword: "keyword",
  doctag: "keyword",
  tag: "keyword",
  name: "keyword",
  "selector-tag": "keyword",
  bullet: "keyword",
  string: "string",
  regexp: "string",
  "template-tag": "string",
  comment: "comment",
  quote: "comment",
  number: "number",
  literal: "number",
  symbol: "number",
  title: "title",
  section: "title",
  "selector-class": "title",
  "selector-id": "title",
  type: "type",
  built_in: "type",
  attr: "variable",
  attribute: "variable",
  property: "variable",
  variable: "variable",
  "template-variable": "variable",
  params: "variable",
  meta: "meta",
  addition: "addition",
  deletion: "deletion",
};

function syntaxRole(className: unknown): string | undefined {
  if (!Array.isArray(className)) return undefined;
  const scope = className.find(
    (name): name is string => typeof name === "string" && name.startsWith("hljs-"),
  );
  return scope ? SYNTAX_ROLES[scope.slice(5)] : undefined;
}

function toReact(nodes: ElementContent[], keyPrefix = "s"): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const key = `${keyPrefix}-${index}`;
    return createElement(
      "span",
      { key, "data-syntax": syntaxRole(node.properties?.className) },
      ...toReact(node.children, key),
    );
  });
}

/**
 * Returns highlighted code nodes once the lazily loaded highlighter has
 * processed `code`, or null for unknown languages and before loading ends.
 */
export function useSyntaxHighlight(code: string, language?: string): ReactNode[] | null {
  const [result, setResult] = useState<{ key: string; nodes: ReactNode[] } | null>(null);
  const key = `${language ?? ""}\u0000${code}`;

  useEffect(() => {
    if (!language) return;
    let cancelled = false;
    void loadLowlight().then((lowlight) => {
      if (cancelled || !lowlight.registered(language)) return;
      const tree: Root = lowlight.highlight(language, code);
      setResult({ key, nodes: toReact(tree.children as ElementContent[]) });
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code, key, language]);

  return result?.key === key ? result.nodes : null;
}
