type Target = { frames?: string[]; el: string };
/** Page HTML by name; images/frames take the cross-site origin for their resources and iframe. */
export declare const pages: { [name: string]: string | ((other: string) => string) };
export declare const cases: Array<Target & { id: string; page: string; secret?: string[]; scripts?: boolean; masks?: Target[];
  area?: { from: string; to: string; inset: [number, number, number, number] } }>;
