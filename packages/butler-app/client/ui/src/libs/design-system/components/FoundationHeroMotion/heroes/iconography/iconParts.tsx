import { type ReactNode } from "react";
import { Typo } from "../../../Typo";
import { STEPS } from "./iconCopy";

export const GRID_LENGTH = 25 * 48;

/** Stroke paths the gear may have (drawn one after another). */
export const GLYPH_PATHS = 4;

/** Stroke elements of a Hugeicons glyph (all its shapes are strokes). */
export const STROKES = ":is(path, circle, ellipse)";

/** A word in one type role. */
export function roleText(role: (typeof STEPS)[number]["role"], text: ReactNode) {
  switch (role) {
    case "caption": return <Typo.Caption>{text}</Typo.Caption>;
    case "body": return <Typo.Body>{text}</Typo.Body>;
    case "h4": return <Typo.H4 as="span">{text}</Typo.H4>;
    case "h3": return <Typo.H3 as="span">{text}</Typo.H3>;
    case "h2": return <Typo.H2 as="span">{text}</Typo.H2>;
  }
}
