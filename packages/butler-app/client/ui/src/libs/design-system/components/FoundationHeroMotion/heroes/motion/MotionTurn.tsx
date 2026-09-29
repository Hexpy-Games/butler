

/**
 * One conversation turn exactly as Butler renders it (checked against the app
 * on an isolated gateway): the user row (bubble, then time and copy), the
 * activity row while the model works (the working mark and the shimmering
 * status), the answer (Markdown, the footer with copy, worked-for and time,
 * then the terminal status row with the settled mark), and the composer.
 * `t` names parts for the timeline (undefined in a still tile).
 */
export type Name = (name: string) => string | undefined;
