type Bounds = { x: number; y: number; width: number; height: number };
export function captureLinkMenu(bounds: Bounds, path: string): void;
export function compileMenuInspector(dir: string): string;
export function nativeMenuBounds(pid: number, inspector: string): Bounds;
