import { useEffect } from "react";
import { announceFullResetOutcome } from "@/app/fullReset.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { Toaster } from "@/butler-ds";

export function AppToaster() {
  // The Toaster child subscribes before this effect runs, so the toast is shown.
  useEffect(() => announceFullResetOutcome((message) => notifyStatus(message, { id: "full-reset", tone: "error" })), []);
  return (
    <Toaster
      mobileOffset={{ top: "var(--titlebar-safe-area-top)" }}
      offset={{ top: "var(--titlebar-safe-area-top)" }}
    />
  );
}
