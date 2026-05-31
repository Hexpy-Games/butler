import { useEffect, useMemo, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import {
  getNativeNotificationStatus,
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
  const [status, setStatus] = useState<NativeNotificationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const statusText = useMemo(() => statusLabel(status), [status]);
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
        notifyStatus("테스트 알림을 보냈습니다.", {
          id: "native-notification-test",
          tone: "ok",
        });
      } else {
        notifyStatus(result.error ?? "운영체제가 알림을 표시하지 않았습니다.", {
          id: "native-notification-test",
          tone: "error",
        });
      }
    } catch (error) {
      notifyError(error, "테스트 알림 실패", {
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
        notifyStatus(result.error ?? "운영체제 알림 설정을 열 수 없습니다.", {
          id: "native-notification-settings",
          tone: "error",
        });
      }
    } catch (error) {
      notifyError(error, "알림 설정 열기 실패", {
        id: "native-notification-settings",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsField
      label="OS 알림 상태"
      description={status?.details ?? copy.status.checking}
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
            테스트
          </Button>
          {status?.can_open_settings ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void openSystemSettings()}
            >
              <Settings size={15} />
              {status.settings_label ?? copy.settings.fallback}
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
  if (!status) return "확인 중";
  if (!status.supported || status.permission === "unsupported") {
    return `${platformLabel(status.platform)} · 지원 안 함`;
  }
  return `${platformLabel(status.platform)} · 권한 상태 확인 필요`;
}

function platformLabel(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  if (platform === "browser") return "Browser";
  return platform || "Unknown";
}
