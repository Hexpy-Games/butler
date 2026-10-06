export const BROWSER_BUILD: Readonly<{ major: number; eol: string }>;
export function browsingEnabled(version?: string, now?: number): boolean;
export function webUrl(value: string): string | null;
export function addressUrl(input: string): string | null;
export function createLossBreaker(onTrip: () => void, now?: () => number): { readonly tripped: boolean; loss(hasTabs: boolean): void };
