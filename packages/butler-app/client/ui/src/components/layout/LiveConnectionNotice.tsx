import { useAppLocale } from "@/app/copy.ts";
import { Notice } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";

export function LiveConnectionNotice() {
  useAppLocale();
  const disconnected = useButlerStore((state) => state.liveConnectionLost);
  if (!disconnected) return null;
  return (
    <div role="status" aria-live="polite" data-test-class="live-connection-notice">
      <Notice tone="warning" message={appCopy.feedback.reconnecting} />
    </div>
  );
}
