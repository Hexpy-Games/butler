declare const __BUTLER_BROWSER_ENABLED__: boolean;

/** Build-time product gate. Unbundled tests and development default to on. */
export const browserFeatureEnabled = typeof __BUTLER_BROWSER_ENABLED__ === "undefined"
  ? true : __BUTLER_BROWSER_ENABLED__;
