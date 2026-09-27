/// <reference types="bun" />
import { expect, test } from "bun:test";
import { fluidToneFromColorScheme } from "./promptFluidTone";

test("the fluid tone follows the nearest theme scope's color-scheme", () => {
  // `.theme-dark` / `.theme-light` set a single color-scheme: it wins over the system.
  expect(fluidToneFromColorScheme("dark", false)).toBe("dark");
  expect(fluidToneFromColorScheme("light", true)).toBe("light");
  expect(fluidToneFromColorScheme(" only dark ", false)).toBe("dark");
});

test("an unscoped or dual color-scheme falls back to the system preference", () => {
  for (const scheme of ["normal", "", "light dark", "dark light"]) {
    expect(fluidToneFromColorScheme(scheme, true)).toBe("dark");
    expect(fluidToneFromColorScheme(scheme, false)).toBe("light");
  }
});
