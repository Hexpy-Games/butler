import { useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications.ts";

export function useDecision() {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  return { busy, run: async (action: () => Promise<unknown>, refresh?: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await action(); }
    catch (error) {
      const conflict = (error as { status?: number }).status === 409;
      if (conflict) await refresh?.().catch(() => undefined);
      notifyStatus(conflict ? appCopy.conversation.initiated.alreadyHandled : appCopy.conversation.initiated.failed, { tone: "error" });
    } finally { inFlight.current = false; setBusy(false); }
  } };
}
