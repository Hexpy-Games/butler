// WHATWG host globals this package uses. Hermes (Expo), browsers and Bun provide them; the ES2022 lib does not declare them.
declare class URL { constructor(url: string, base?: string); readonly protocol: string; readonly href: string; }
