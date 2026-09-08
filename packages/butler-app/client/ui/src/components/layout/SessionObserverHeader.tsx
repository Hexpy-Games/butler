import { useAppLocale } from "@/app/copy.ts";
import { ArrowLeft, Button, DialogDescription, DialogHeader, DialogTitle, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import styles from "./SessionObserverDialog.module.css";

export function SessionObserverHeader() {
  useAppLocale();
  const title = useButlerStore((state) => {
    const sessionId = state.observerSessionId;
    return sessionId ? state.sessionViews[sessionId]?.relation?.safe_title ?? sessionId : "";
  });
  const canGoBack = useButlerStore((state) => state.observerHistory.length > 0);
  const goBack = useButlerStore((state) => state.goBackSessionObserver);
  return (
    <DialogHeader className={styles.header} data-test-class="steward-observer-header">
      <Stack align="row" cross="center" gap="xs">
        {canGoBack ? (
          <Button
            variant="borderless"
            size="icon-sm"
            aria-label={appCopy.common.back}
            title={appCopy.common.back}
            onClick={goBack}
          >
            <ArrowLeft size={18} />
          </Button>
        ) : null}
        <DialogTitle>{title}</DialogTitle>
      </Stack>
      <DialogDescription id="steward-observer-description">
        {appCopy.inspector.tabs.activity}
      </DialogDescription>
    </DialogHeader>
  );
}
