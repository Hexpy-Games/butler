/// <reference types="bun" />

import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { setAppCopyLanguage } from "@/app/copy.ts";
import { UsageBucketPanel } from "./UsageBucketPanel";
import { UsageProviderRow } from "./UsageProviderRow";
import { UsageSectionPanel } from "./UsageSectionPanel";
import { UsageToolPanel } from "./UsageToolPanel";

const bucket = { requestCount: 3, promptTokens: 36460, cachedTokens: 8200, uncachedTokens: 28260, outputTokens: 4420,
  totalTokens: 40880, missingTotalTokenCount: 0 };

function metaTexts(markup: string): string[] {
  const document = new JSDOM(markup).window.document;
  return Array.from(document.querySelectorAll("dl > div")).map((item) => item.textContent ?? "");
}

for (const language of ["en", "ko"] as const) {
  test(`usage metadata keeps a space between each label and value (${language})`, () => {
    setAppCopyLanguage(language);
    const markup = [
      renderToStaticMarkup(<UsageBucketPanel title="Tokens" rows={[{ name: "conversation", bucket } as never]} />),
      renderToStaticMarkup(<UsageToolPanel rows={[["Bash", { calls: 21, results: 21, successes: 20, failures: 1 } as never]]} />),
      renderToStaticMarkup(<UsageSectionPanel rows={[["system", { requestCount: 30, chars: 48210, estimatedTokens: 12050 }]]} />),
      renderToStaticMarkup(<UsageProviderRow provider={{
        ...bucket, providerId: "anthropic", source: "provider_adapter", billing: { available: true, reason: "" },
        remaining: { available: false, stale: false, sourceKind: "provider_quota", sourceId: "x", planKind: "unknown",
          planName: null, windows: [], fetchedAt: null, reason: { code: "provider_quota_surface_unavailable", message: "" } },
      } as never} />),
    ].join("");
    const texts = metaTexts(markup);
    expect(texts.length).toBeGreaterThanOrEqual(10);
    for (const text of texts) {
      // "Input36,460", "입력36,460" or "Billing:Confirmed" read as one word.
      expect(text, text).not.toMatch(/[\p{L}:][\d]|:\S/u);
      expect(text, text).not.toMatch(/^·|·$/u);
    }
  });
}
