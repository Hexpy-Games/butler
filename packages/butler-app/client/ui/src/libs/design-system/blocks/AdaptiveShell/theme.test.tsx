/// <reference types="bun" />

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TitlebarShell } from "../TitlebarShell";
import { adaptiveShellThemeClasses } from "./theme";

test("the shell theme maps to the global theme token classes", () => {
  expect(adaptiveShellThemeClasses({ appearance: "dark" })).toBe("theme-dark sidebar-translucent main-screen-theme-bloom");
  expect(adaptiveShellThemeClasses({ appearance: "light", sidebar: "solid", mainScreen: "none" }))
    .toBe("theme-light sidebar-solid main-screen-theme-none");
});

test("TitlebarShell dragRegion makes the titlebar a window drag region", () => {
  expect(renderToStaticMarkup(<TitlebarShell title="Chat" dragRegion />)).toContain("drag-region");
  expect(renderToStaticMarkup(<TitlebarShell title="Chat" />)).not.toContain("drag-region");
});
