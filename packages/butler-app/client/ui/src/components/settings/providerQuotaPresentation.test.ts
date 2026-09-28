import { afterAll, expect, test } from "bun:test";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import { quotaReasonLabel } from "./providerQuotaPresentation";

const previousLocale = getAppLocale();
afterAll(() => setAppCopyLanguage(previousLocale));

test("quota reasons read as terse labels in both languages", () => {
  setAppCopyLanguage("ko-KR");
  expect(quotaReasonLabel("provider_quota_pending")).toBe("아직 데이터 없음");
  expect(quotaReasonLabel("provider_quota_fetch_failed")).toBe("조회 실패");
  expect(quotaReasonLabel("provider_quota_not_offered", "api")).toBe("API 요금제");
  expect(quotaReasonLabel("provider_quota_not_offered", "unknown")).toBe("미지원");
  setAppCopyLanguage("en");
  expect(quotaReasonLabel("provider_quota_pending")).toBe("No data yet");
  expect(quotaReasonLabel("provider_quota_fetch_failed")).toBe("Couldn't check");
  expect(quotaReasonLabel("provider_quota_not_offered", "api")).toBe("API plan");
  expect(quotaReasonLabel("provider_quota_not_offered", "subscription")).toBe("Not available");
});
