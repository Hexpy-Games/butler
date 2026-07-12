import { useEffect } from "react";

const LIGHT_APP_CHROME = "#f2f3f4";
const LIGHT_NEW_CHAT_CHROME = "#e7ecf2";
const DARK_APP_CHROME = "#1f2023";
const DARK_NEW_CHAT_CHROME = "#1a1b1e";

export function useBrowserChromeThemeColor({
  active,
  dark,
  enabled,
}: {
  active: boolean;
  dark: boolean;
  enabled: boolean;
}) {
  useEffect(() => {
    if (!enabled) return;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    const color = active
      ? dark
        ? DARK_NEW_CHAT_CHROME
        : LIGHT_NEW_CHAT_CHROME
      : dark
        ? DARK_APP_CHROME
        : LIGHT_APP_CHROME;
    meta?.setAttribute("content", color);
    document.documentElement.style.backgroundColor = color;
    document.body.style.backgroundColor = color;
    return () => {
      document.documentElement.style.backgroundColor = "";
      document.body.style.backgroundColor = "";
    };
  }, [active, dark, enabled]);
}
