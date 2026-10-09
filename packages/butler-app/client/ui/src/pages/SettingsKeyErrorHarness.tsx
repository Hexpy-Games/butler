import { appCopy } from "@/app/copy";
import { FirstRunKeyForm } from "@/components/first-run/FirstRunKeyForm";
import type { FirstRunFlow } from "@/components/first-run/useFirstRunFlow";

/** Only the form's navigation and successful commit callbacks are stubbed. */
export function SettingsKeyErrorHarness() {
  const flow = { copy: appCopy.firstRun, step: "connect", mode: "first-run", language: "en", view: { kind: "key" }, readiness: { status: "ready" }, retryPreparation: () => {}, commit: { connected: null }, backToList: () => {}, connectKey: () => {} };
  return <FirstRunKeyForm cardId="openai" flow={flow as unknown as FirstRunFlow} />;
}
