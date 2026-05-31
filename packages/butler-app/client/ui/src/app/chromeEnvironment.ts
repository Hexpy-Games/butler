export type ChromeEnvironment = "electron" | "browser";

export function chromeEnvironment(): ChromeEnvironment {
  if (typeof window === "undefined") return "browser";
  return window.butlerApp ? "electron" : "browser";
}

export function chromeEnvironmentClassName(): string {
  return chromeEnvironment() === "electron"
    ? "electron-chrome"
    : "browser-chrome";
}
