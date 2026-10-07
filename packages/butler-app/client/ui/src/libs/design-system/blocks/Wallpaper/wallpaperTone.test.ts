// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { wallpaperToneFromColorScheme } from "./wallpaperTone";

test("the wallpaper tone follows the nearest theme scope's color-scheme", () => {
  // `.theme-dark` / `.theme-light` set a single color-scheme: it wins over the system.
  expect(wallpaperToneFromColorScheme("dark", false)).toBe("dark");
  expect(wallpaperToneFromColorScheme("light", true)).toBe("light");
  expect(wallpaperToneFromColorScheme(" only dark ", false)).toBe("dark");
});

test("an unscoped or dual color-scheme falls back to the system preference", () => {
  for (const scheme of ["normal", "", "light dark", "dark light"]) {
    expect(wallpaperToneFromColorScheme(scheme, true)).toBe("dark");
    expect(wallpaperToneFromColorScheme(scheme, false)).toBe("light");
  }
});
