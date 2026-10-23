import { useEffect, useRef } from "react";
import { onChatGptEvent } from "@/app/chatGptEvents";
import { appCopy } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { acknowledgeChatGptNotice } from "@/app/setupSignIn";
import { manageChatGptUsage, openChatGptSignIn } from "./chatGptActions";
import { useChatGptAccount } from "./useChatGptAccount";
/** Once-only account migration and the existing route-fallback notice. */
export function useChatGptNotices() {
  const { account, setAccount } = useChatGptAccount();
  const legacyShown = useRef(false);
  const fallbackShown = useRef(new Set<string>());
  useEffect(() => {
    if (!account?.legacy_prompt_pending || legacyShown.current) return;
    legacyShown.current = true;
    notifyStatus(appCopy.chatgptPlan.legacyToast, {
      id: "chatgpt-legacy", action: { label: appCopy.chatgptPlan.continue, onClick: () => openChatGptSignIn() },
    });
    void acknowledgeChatGptNotice("legacy").then(setAccount).catch(() => {});
  }, [account?.legacy_prompt_pending]);
  useEffect(() => onChatGptEvent(event => {
    if (event.type !== "assistant.public_note" || event.payload?.failureCode !== "provider_quota_exhausted" || event.payload?.authType !== "chatgpt_oauth") return;
    const key = String(event.payload?.semanticBlockId ?? event.id);
    if (fallbackShown.current.has(key)) return;
    fallbackShown.current.add(key);
    notifyStatus(appCopy.chatgptPlan.limitFallback, {
      id: "chatgpt-limit-fallback", action: { label: appCopy.chatgptPlan.manageUsage, onClick: manageChatGptUsage },
    });
  }), []);
}
