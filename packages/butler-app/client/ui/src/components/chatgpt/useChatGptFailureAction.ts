import { onChatGptEvent } from "@/app/chatGptEvents";
import { useEffect, useState } from "react";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import type { ProviderQuotaResultView } from "@/app/types";
import { manageChatGptUsage, openChatGptSignIn } from "./chatGptActions";
export function useChatGptFailureAction(code?: string) {
  const [limit, setLimit] = useState(false);
  useEffect(() => {
    if (code !== "provider_quota_exhausted") return;
    let alive = true, revision = 0;
    const read = () => {
      const current = ++revision;
      void api<ProviderQuotaResultView>("/provider-quota?provider_id=openai").then(view => {
        if (alive && current === revision) setLimit(view.planUsage?.state === "limit_reached");
      }).catch(() => {});
    };
    read();
    const stop = onChatGptEvent(event => {
      if (event.type === "provider_quota_updated" || event.type === "setup.chatgpt_account_changed") read();
    });
    return () => { alive = false; stop(); };
  }, [code]);
  if (code === "chatgpt_sign_in_required") return { label: appCopy.chatgptPlan.continue, run: () => openChatGptSignIn() };
  if (code === "chatgpt_plan_not_enabled") return { label: appCopy.chatgptPlan.turnOn, run: () => openChatGptSignIn("enable_plan") };
  return code === "provider_quota_exhausted" && limit ? { label: appCopy.chatgptPlan.manageUsage, run: manageChatGptUsage } : null;
}
