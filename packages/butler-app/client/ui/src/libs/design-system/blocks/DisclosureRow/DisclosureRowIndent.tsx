import { createContext, useContext, type ReactNode } from "react";

/** Text-only indent for the DisclosureRows directly inside: level (16px each) and an optional depth cue. */
export interface DisclosureRowIndentValue {
  level: number;
  cue?: ReactNode;
}

const IndentContext = createContext<DisclosureRowIndentValue | null>(null);

/**
 * Indents only the text of the DisclosureRow inside (title line,
 * description, panel); its fill and `bar` keep the full width. DS-internal:
 * SpanRow indent="text" provides it. A row's panel resets it, so rows nested
 * in details are not indented.
 */
export function DisclosureRowIndent({ level, cue, children }: DisclosureRowIndentValue & { children: ReactNode }) {
  return <IndentContext.Provider value={{ level, cue }}>{children}</IndentContext.Provider>;
}

/** Clears the indent for content nested inside a row's panel. */
export function DisclosureRowIndentReset({ children }: { children: ReactNode }) {
  return <IndentContext.Provider value={null}>{children}</IndentContext.Provider>;
}

export function useDisclosureRowIndent(): DisclosureRowIndentValue | null {
  return useContext(IndentContext);
}
