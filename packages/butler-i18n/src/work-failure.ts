import type { AppLocale } from "./copy-contract.ts";

const reasons = {
  hook_blocked: { "ko-KR": "설정된 규칙이 막았어요", "en-US": "A configured rule blocked it" },
  session_model_unavailable: { "ko-KR": "모델을 사용할 수 없어요", "en-US": "The model isn't available" },
  invalid_request: { "ko-KR": "요청을 처리할 수 없어요", "en-US": "The request can't be processed" },
  unknown_error: { "ko-KR": "알 수 없는 오류예요", "en-US": "Unknown error" },
};
const notices = {
  "ko-KR": { failed: "작업 결과를 전달하지 못했어요", retrying: "작업 결과를 아직 전달하지 못했어요", continuing: "계속 다시 시도하고 있어요" },
  "en-US": { failed: "Couldn't deliver the work result", retrying: "The work result hasn't been delivered yet", continuing: "Still retrying" },
};

/** Render gateway state using UI language, with unknown codes falling back safely. */
export function workFailureLine(locale: AppLocale, state: "retrying" | "failed" | undefined, reasonCode: string | undefined): string {
  const code = reasonCode && Object.hasOwn(reasons, reasonCode) ? reasonCode as keyof typeof reasons : "unknown_error";
  const copy = notices[locale];
  const retrying = state === "retrying";
  return [retrying ? copy.retrying : copy.failed,
    ...(!retrying || code !== "unknown_error" ? [reasons[code][locale]] : []),
    ...(retrying ? [copy.continuing] : [])].join(" · ");
}
