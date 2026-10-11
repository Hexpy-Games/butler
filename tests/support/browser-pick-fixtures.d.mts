type At = { frames: string[]; el: string; fx: number; fy: number; dx: number; dy: number } | { x: number; y: number };
/** Page HTML by name; frames/mix take the cross-site origin for their iframe. */
export declare const pages: { [name: string]: string | ((other: string) => string) };
export declare const cases: Array<{ id: string; page: string; at: At; target: { frames: string[]; el: string; clip?: string }; steps: number; secret?: string[]; masks?: string[] }>;
export declare const areas: Array<{ id: string; page: string; from: At; to: At; contains: string[]; excludes: string[]; within?: number; masks?: string[] }>;
