import type { GuidedToolJournalRecord } from "../../adapters/index.ts";
import type { GuidedEffectJournalRecord } from "../effects/index.ts";
import {
  evidenceCapabilityReceiptsFromResult,
} from "../../output/evidence/receipts.ts";
import type { EvidenceCapabilityKind } from "../../output/evidence/types.ts";
import { sanitizePublicText } from "../../events/turn-events.ts";

const FACT_VALUE_LIMIT = 480;

/**
 * Converts only typed, verified capability receipts into public facts. Legacy
 * summary fields are intentionally ignored because they have no safe schema.
 */
export function safeToolFacts(
  records: readonly GuidedToolJournalRecord[],
  korean: boolean,
): string[] {
  const facts: string[] = [];
  for (const record of records) {
    if (record.status !== "completed") continue;
    const output = asRecord(record.result);
    if (output?.ok !== true) continue;
    for (const receipt of evidenceCapabilityReceiptsFromResult(output)) {
      if (!receipt.verified || receipt.maturity !== "verified") continue;
      const fact = capabilityFact(receipt.capability, korean);
      if (fact && !facts.includes(fact)) facts.push(fact);
    }
  }
  return facts.slice(0, 3);
}

export function hasSafeAppliedEffect(
  records: readonly GuidedEffectJournalRecord[],
): boolean {
  return records.some((record) => record.status === "applied" && Boolean(record.receipt));
}

export function safeProgressFacts(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map(safeWorkFact)
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 3);
}

export function safeWorkFact(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compacted = compact(value);
  if (!compacted || unsafeOperationalText(compacted)) return null;
  const sanitized = sanitizePublicText(compacted, "");
  return sanitized === compacted ? sanitized : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unsafeOperationalText(value: string): boolean {
  return /[\\/]/u.test(value) ||
    /\b(?:api[_-]?key|token|secret|password|authorization|bearer)\b/iu.test(value) ||
    /\b(?:steward|worker|binding|disposition|fingerprint|phase|connector|mcp|oauth|webhook)\b/iu.test(value) ||
    /\b(?:guided[-_: ]?work|guided[-_: ]?(?:result|diagnostic)|work[-_: ]?id)\b/iu.test(value) ||
    /\b(?:session|turn)[-_ :][a-z0-9]/iu.test(value) ||
    /^\s*[<{[]/u.test(value);
}

function capabilityFact(
  capability: EvidenceCapabilityKind,
  korean: boolean,
): string | null {
  const facts: Partial<Record<EvidenceCapabilityKind, { ko: string; en: string }>> = {
    source_verified: {
      ko: "검증된 소스 근거를 확인했습니다.",
      en: "Verified source evidence was confirmed.",
    },
    command_executed: {
      ko: "명령 실행 결과를 확인했습니다.",
      en: "The command execution result was confirmed.",
    },
    workspace_mutated: {
      ko: "작업공간 변경 결과를 확인했습니다.",
      en: "The workspace change result was confirmed.",
    },
    durable_artifact: {
      ko: "검증된 산출물 근거를 확인했습니다.",
      en: "Verified artifact evidence was confirmed.",
    },
    data_table_created: {
      ko: "검증된 표 산출물 근거를 확인했습니다.",
      en: "Verified table artifact evidence was confirmed.",
    },
    chart_rendered: {
      ko: "검증된 차트 산출물 근거를 확인했습니다.",
      en: "Verified chart artifact evidence was confirmed.",
    },
    validation_passed: {
      ko: "검증 결과를 확인했습니다.",
      en: "The validation result was confirmed.",
    },
    browser_observed: {
      ko: "브라우저 관찰 결과를 확인했습니다.",
      en: "The browser observation was confirmed.",
    },
    review_completed: {
      ko: "검토 결과를 확인했습니다.",
      en: "The review result was confirmed.",
    },
  };
  const fact = facts[capability];
  return fact ? (korean ? fact.ko : fact.en) : null;
}

function compact(value: string): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length <= FACT_VALUE_LIMIT
    ? oneLine
    : `${oneLine.slice(0, FACT_VALUE_LIMIT - 1)}…`;
}
