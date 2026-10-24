import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { openExternalSignIn } from "@/app/openExternalSignIn";
import { useButlerStore } from "@/app/store";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import type { ChatGptAccountView, SignInKind } from "@/app/setupSignIn";
export function manageChatGptUsage(): void { openExternalSignIn("https://chatgpt.com/settings/usage"); }
/** Navigation carries only an explicit action request; selecting a form never creates one. */
export function openChatGptSignIn(kind: SignInKind = "default"): void {
  const store = useButlerStore.getState();
  const model = store.modelCatalog.registered_models?.find(item => item.auth_type === "chatgpt_oauth");
  store.openSettings("models");
  const settings = useSettingsUIStore.getState();
  if (model) settings.openModelEdit(model.model_ref); else settings.openModelAdd();
  useSettingsUIStore.setState({ chatgptSignInKind: kind });
}
export async function signOutChatGpt(): Promise<ChatGptAccountView> {
  const result = await api<{ revoked: boolean; account: ChatGptAccountView }>("/setup/chatgpt-account/sign-out", { method: "POST", body: "{}" });
  useButlerStore.getState().setModelCatalog(await api("/model-catalog"));
  notifyStatus(appCopy.chatgptPlan.signedOut);
  if (!result.revoked) notifyStatus(appCopy.chatgptPlan.revokeUnconfirmed, {
    action: { label: appCopy.chatgptPlan.manageUsage, onClick: manageChatGptUsage },
  });
  return result.account;
}
