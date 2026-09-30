import { appCopy } from "./copy";
import { notifyStatus } from "./notifications";

interface LoginSettings { openAtLogin: boolean }
interface LoginBridge {
  getLoginSettings?: () => Promise<LoginSettings>;
  setLoginSettings?: (input: LoginSettings) => Promise<LoginSettings>;
}
function bridge(): LoginBridge | undefined {
  return typeof window === "undefined" ? undefined : window.butlerApp as LoginBridge | undefined;
}
export async function getLoginSettings(): Promise<LoginSettings | null> {
  return await bridge()?.getLoginSettings?.() ?? null;
}
export async function setLoginSettings(openAtLogin: boolean): Promise<LoginSettings | null> {
  return await bridge()?.setLoginSettings?.({ openAtLogin }) ?? null;
}
/** Check once on list load/change; browser clients have no native login option. */
export async function hintScheduleLogin(): Promise<void> {
  const key = "butler:schedule-login-hint:v1";
  try {
    if (window.localStorage.getItem(key)) return;
    const settings = await getLoginSettings();
    if (!settings || settings.openAtLogin) return;
    window.localStorage.setItem(key, "shown");
    notifyStatus(appCopy.automations.loginHint, { id: "schedule-login-hint" });
  } catch { /* A missing native shell must not block schedules. */ }
}
