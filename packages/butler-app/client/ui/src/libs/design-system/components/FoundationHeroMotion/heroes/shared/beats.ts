/**
 * The beat constants every Foundations chapter hero shares (one beat is
 * --motion-deliberate, 320 ms). Typography set them; the other chapters reuse
 * the same values so every hero moves at one pace.
 */

/** One transition length for every scene and camera change (into the list, list → build, build → build, build → finale, finale → loop). */
export const TRANSITION = 4;

/**
 * Holds: after a completed component before the camera moves on (0.6 s), and
 * on the last list row while its highlight plays (1.8 s).
 */
export const HOLD = { component: 1.9, lastRow: 5.7 } as const;

/** Stagger between list rows; each row starts before the previous one has finished. */
export const ROW = 1.6;

/** Stagger between build steps: a main step gets its own moment, a secondary one a shorter step. */
export const STEP = { main: 1.3, secondary: 0.6 } as const;

/** The finished poster holds this long before the loop. */
export const SETTLE = 8;

/**
 * An opening's beat marks: guides and values draw in, clear for the fill,
 * come back with the live control, and leave for the list.
 */
export const OPENING = { fill: 5, clear: [6.4, 7.2], back: [8.8, 9.6], walk: [9.8, 16.4], away: [17.2, 18] } as const;
