import { afterEach, expect, test } from "bun:test";
import {
  appCopy,
  appLocaleFromLanguage,
  getAppCopy,
  setAppCopyLanguage,
} from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import { useButlerStore } from "../../packages/butler-app/client/ui/src/app/store.ts";

afterEach(() => {
  setAppCopyLanguage("en");
});

test("app copy follows the settings language", () => {
  setAppCopyLanguage("en");
  expect(appLocaleFromLanguage("en")).toBe("en-US");
  expect(appCopy.sidebar.newChat).toBe("New chat");
  expect(appCopy.settings.title).toBe("Settings");
  expect(appCopy.composer.placeholder).toBe("Ask Butler anything");

  setAppCopyLanguage("ko");
  expect(appLocaleFromLanguage("ko")).toBe("ko-KR");
  expect(appCopy.sidebar.newChat).toBe("새 대화");
  expect(appCopy.settings.title).toBe("설정");
});

test("explicit copy lookup exposes English and Korean locales", () => {
  expect(getAppCopy("en-US").settings.options.english).toBe("English");
  expect(getAppCopy("ko-KR").settings.options.english).toBe("영어");
});

test("settings store switches app copy language when gateway settings load", () => {
  useButlerStore.getState().setSettings({
    ...EMPTY_SETTINGS,
    language: "en",
  });
  expect(appCopy.sidebar.settings).toBe("Settings");

  useButlerStore.getState().setSettings({
    ...EMPTY_SETTINGS,
    language: "ko",
  });
  expect(appCopy.sidebar.settings).toBe("설정");
});
