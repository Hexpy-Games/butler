import { Button, Inline, Spinner, Typo } from "@/butler-ds";
import type { MemoryModelProgress } from "@/app/setupReadiness.ts";

const REASONS: Record<string, [string, string]> = {
  embed_asset_download_failed: ["연결을 확인하세요", "Check connection"],
  embed_asset_unavailable: ["저장 공간을 확인하세요", "Check storage"],
  embed_asset_hash_mismatch: ["파일 확인 실패", "File verification failed"],
  embed_asset_range_invalid: ["다운로드 응답 오류", "Invalid download response"],
  embed_asset_path_unsafe: ["저장 경로를 확인하세요", "Check cache path"],
  embed_asset_version_conflict: ["모델 캐시를 확인하세요", "Check model cache"],
};

/** Optional memory preparation; never changes setup eligibility. */
export function MemoryModelStatus({ model, language, retry }: {
  model?: MemoryModelProgress; language: string; retry: () => void;
}) {
  if (!model || model.state === "ready") return null;
  const ko = language.startsWith("ko");
  const failed = model.state === "failed";
  const label = failed ? (ko ? "메모리 모델 다운로드 실패" : "Memory model download failed")
    : model.state === "verifying" ? (ko ? "메모리 모델 확인 중" : "Verifying memory model")
      : (ko ? "메모리 모델 받는 중" : "Downloading memory model");
  const percent = model.bytes_total > 0 ? Math.floor(model.bytes_done / model.bytes_total * 100) : 0;
  const size = `${Math.round(model.bytes_done / 1_000_000)} / ${Math.round(model.bytes_total / 1_000_000)} MB`;
  return (
    <Inline role="status" wrap data-test-class="memory-model-status" gap="sm">
      {!failed ? <Spinner size={14} /> : null}
      <Typo.Caption tone={failed ? "danger" : "secondary"}>{label}</Typo.Caption>
      {failed && model.reason && REASONS[model.reason] ? <Typo.Caption tone="secondary">{REASONS[model.reason][ko ? 0 : 1]}</Typo.Caption> : null}
      <Typo.Caption numeric="tabular" tone="tertiary">{`${percent}% · ${size}`}</Typo.Caption>
      {failed ? <Button size="sm" variant="ghost" onClick={retry}>{ko ? "다시 시도" : "Retry"}</Button> : null}
    </Inline>
  );
}
