import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  getNativeNotificationStatus,
  nativeNotificationStatusDetails,
  nativeNotificationSettingsLabel,
  openNativeNotificationSettings,
  testDesktopNotification,
  type NativeNotificationStatus,
} from "@/app/nativeNotifications.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import {
  Button,
  Settings,
  SettingsField,
  ShieldQuestion,
  Stack,
  Typo,
} from "@/butler-ds";

export function NativeNotificationStatusPanel() {
  useAppLocale();
  const [status, setStatus] = useState<NativeNotificationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const statusText = statusLabel(status);
  const copy = appCopy.settings.nativeNotifications;

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      const next = await getNativeNotificationStatus();
      if (!cancelled) setStatus(next);
    }
    void loadStatus().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function runTestNotification() {
    setBusy(true);
    try {
      const result = await testDesktopNotification();
      setStatus(result.status);
      if (result.shown) {
        notifyStatus(appCopy.interfaceStatus.notificationSent, {
          id: "native-notification-test",
          tone: "ok",
        });
      } else {
        notifyStatus(result.error ?? appCopy.interfaceStatus.notificationHidden, {
          id: "native-notification-test",
          tone: "error",
        });
      }
    } catch (error) {
      notifyError(error, appCopy.interfaceStatus.notificationFailed, {
        id: "native-notification-test",
      });
    } finally {
      setBusy(false);
    }
  }

  async function openSystemSettings() {
    setBusy(true);
    try {
      const result = await openNativeNotificationSettings();
      setStatus(result.status);
      if (!result.opened) {
        notifyStatus(result.error ?? appCopy.interfaceStatus.notificationSettingsUnavailable, {
          id: "native-notification-settings",
          tone: "error",
        });
      }
    } catch (error) {
      notifyError(error, appCopy.interfaceStatus.notificationSettingsFailed, {
        id: "native-notification-settings",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsField
      label={appCopy.interfaceStatus.notificationStatus}
      description={status ? nativeNotificationStatusDetails(status.details_code) : copy.status.checking}
      control={
        <Stack align="row" gap="xs" wrap>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void runTestNotification()}
          >
            <ShieldQuestion size={15} />
            {appCopy.interfaceStatus.test}</Button>
          {status?.can_open_settings ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void openSystemSettings()}
            >
              <Settings size={15} />
              {nativeNotificationSettingsLabel(status.settings_target ?? null) ?? copy.settings.fallback}
            </Button>
          ) : null}
        </Stack>
      }
      meta={
        <Stack gap="xs">
          <Typo.Caption>{statusText}</Typo.Caption>
          {status?.last_error ? (
            <Typo.Caption>{status.last_error}</Typo.Caption>
          ) : null}
        </Stack>
      }
    />
  );
}

function statusLabel(status: NativeNotificationStatus | null): string {
  if (!status) return appCopy.interfaceStatus.checking;
  if (!status.supported || status.permission === "unsupported") {
    return `${platformLabel(status.platform)} · ${appCopy.interfaceStatus.unsupported}`;
  }
  return `${platformLabel(status.platform)} · ${appCopy.interfaceStatus.permissionCheck}`;
}

function platformLabel(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  if (platform === "browser") return "Browser";
  return platform || appCopy.interfaceStatus.unknown;
}
