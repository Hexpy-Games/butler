

/** Weights whose values the changing labels cut between (drawn, pushed, settled). */
export const LABEL_WEIGHTS = [300, 800, 620] as const;

/** Dash length of each outline, in em: longer than the glyph's contours so the stroke draws from nothing. */
export const OUTLINE_EM = { a: 4, g: 7 } as const;
