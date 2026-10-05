import { appCopy } from "@/app/copy";
import type { ComponentUpdateStatus } from "@/app/types";
import { Button, ButtonContainer, Field, FieldLabel, ProgressMeter, Spinner, Stack, Typo } from "@/butler-ds";
import type { ProposalLocale, UpdateFailure, UpdateStage } from "../state";
import { UPDATE_BYTES } from "./updateFixture";

// REVIEW REPLICA of origin/codex/update-progress (UpdateComponentRow + UpdateProgressPanel), as
// written there, so the owner can compare. Not a proposal. Its copy is the branch's copy.

const CODEX_COPY = {
  "ko-KR": {
    checking: "확인 중", downloading: "다운로드 중", verifying: "검증 중", ready: "설치 준비됨",
    applying: "적용 중", restarting: "재시작 중", failed: "업데이트 실패", retry: "다시 시도", cancel: "취소",
    bytesUnavailable: "진행률을 제공하지 않습니다.", checksumFailed: "체크섬이 일치하지 않습니다.",
    sourceFailed: "업데이트를 가져오지 못했습니다.", activationFailed: "업데이트를 적용하지 못했습니다.",
  },
  "en-US": {
    checking: "Checking", downloading: "Downloading", verifying: "Verifying", ready: "Ready to install",
    applying: "Applying", restarting: "Restarting", failed: "Update failed", retry: "Retry", cancel: "Cancel",
    bytesUnavailable: "Progress is unavailable.", checksumFailed: "Package checksum did not match.",
    sourceFailed: "Could not fetch the update.", activationFailed: "Could not apply the update.",
  },
} as const;

type CodexStage = "checking" | "downloading" | "verifying" | "ready" | "applying" | "restarting" | "failed";

function codexStage(stage: UpdateStage): CodexStage | null {
  if (stage === "downloadingUnknown") return "downloading";
  if (stage === "activating") return "restarting";
  if (stage === "deferred") return "ready";
  return stage === "available" || stage === "upToDate" ? null : stage;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CodexUpdateRow({ status, stage, failure, locale }: {
  status: ComponentUpdateStatus; stage: UpdateStage; failure: UpdateFailure; locale: ProposalLocale;
}) {
  const copy = CODEX_COPY[locale];
  const progress = status.update_available ? codexStage(stage) : null;
  const running = progress !== null && progress !== "failed";
  const known = progress === "downloading" && stage !== "downloadingUnknown";
  const { done, total } = UPDATE_BYTES;
  const reason = failure === "damaged" ? copy.checksumFailed : failure === "apply" ? copy.activationFailed : copy.sourceFailed;
  return (
    <Field data-test-id={`update-component-${status.component}`} data-test-class="settings-field">
      <Stack align="row" justify="between" cross="center" gap="md" wrap>
        <Stack gap="xs">
          <FieldLabel>{appCopy.settings.updateComponents[status.component]}</FieldLabel>
          <Typo.Caption>{status.update_available ? `${status.current_version} -> ${status.available_version}` : status.current_version}</Typo.Caption>
        </Stack>
        <Button type="button" size="sm" variant={status.update_available ? "default" : "outline"}
          disabled={running || (!status.update_available && progress !== "failed")}>
          {progress === "failed" ? copy.retry : running ? copy[progress] : status.update_available ? appCopy.settings.actions.updateComponent : appCopy.settings.actions.upToDate}
        </Button>
      </Stack>
      {progress ? (
        <Stack gap="xs" role="status">
          {known ? (
            <ProgressMeter label={copy.downloading} ariaLabel={copy.downloading} value={(done / total) * 100}
              meta={`${Math.floor((done / total) * 100)}% · ${formatBytes(done)} / ${formatBytes(total)}`} />
          ) : (
            <Stack align="row" cross="center" gap="sm">
              {progress !== "failed" && progress !== "ready" ? <Spinner /> : null}
              <Typo.Caption>{progress === "failed" ? copy.failed : copy[progress]}</Typo.Caption>
            </Stack>
          )}
          {progress === "downloading" && !known ? <Typo.Caption>{`${formatBytes(done)} · ${copy.bytesUnavailable}`}</Typo.Caption> : null}
          {progress === "downloading" ? <Typo.Caption>{formatBytes(4_200_000)}/s</Typo.Caption> : null}
          {progress === "failed" ? <Typo.Caption>{reason}</Typo.Caption> : null}
          {progress === "downloading" ? (
            <ButtonContainer size="sm"><Button size="sm" variant="outline">{copy.cancel}</Button></ButtonContainer>
          ) : null}
        </Stack>
      ) : null}
    </Field>
  );
}
