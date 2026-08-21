const SUBSTANTIAL_DELEGATION_INTENT = /(?:문서|초안|보고서|기획서|제안서|전체\s*(?:대체|수정|개정|작성)|작성(?:해|하|을|해서)|수정(?:해|하|을|해서)|개정|보강|복원|재작성|다듬어|정리해|요약해|조사(?:해|하|를|해서)|연구|비교(?:해|하|를)|분석(?:해|하|을)|검토(?:해|하|를)|검증해|찾아봐|구현(?:해|하|을)|개발(?:해|하|을)|고쳐|바꿔|업데이트(?:해|하)|적용(?:해|하)|진행해|다시\s*해|그렇게\s*해|(?:write|draft|revise|rewrite|edit|summarize|review|research|investigate|inspect|compare|analy[sz]e|verify|implement|build|update)\b)/iu;

/**
 * This is a narrow runtime guard for objectives that must not terminate as a
 * promise-only Butler reply. The model still chooses among direct knowledge,
 * one quick lookup, steering an active child, or a fresh delegation for every
 * request outside this explicit substantial-work boundary.
 */
export function requiresStewardDelegationIntent(message: string): boolean {
  return SUBSTANTIAL_DELEGATION_INTENT.test(message.trim());
}

export function ordinaryChatPhaseForIntent(
  policy: Pick<ButlerExecutionPolicy, "role" | "accessMode">,
  message: string,
): "direct" | "execution" {
  return policy.role === "butler" &&
      policy.accessMode === "full_access" &&
      requiresStewardDelegationIntent(message)
    ? "execution"
    : "direct";
}
import type { ButlerExecutionPolicy } from "../contracts.ts";
