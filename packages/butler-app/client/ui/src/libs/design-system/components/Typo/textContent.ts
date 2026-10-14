import { Children, Fragment, isValidElement, type ReactNode } from "react";

/** Phrasing elements that stay part of the text line (no box of their own). */
const TEXT_ELEMENTS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn", "em", "i", "ins",
  "kbd", "mark", "q", "s", "samp", "small", "strong", "sub", "sup", "time", "u", "var", "wbr",
]);

/**
 * Whether the children are only text: strings, numbers and text-level elements
 * holding text. The cap/baseline trim can only cut text lines; a box child
 * (a component, an icon, a flex row) keeps its full height, so the trim's
 * padding would be added on top of it.
 */
export function isTextContent(children: ReactNode): boolean {
  return Children.toArray(children).every((child) => {
    if (typeof child === "string" || typeof child === "number") return true;
    if (!isValidElement<{ children?: ReactNode }>(child)) return false;
    const textElement = child.type === Fragment || (typeof child.type === "string" && TEXT_ELEMENTS.has(child.type));
    return textElement && isTextContent(child.props.children);
  });
}
