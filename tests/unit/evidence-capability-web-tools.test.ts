import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildEvidenceCapabilityLedger } from "../../packages/butler-agent/src/agent/output/evidence/ledger.ts";
import { createWebReadHandler } from "../../packages/butler-agent/src/agent/tools/web-read/index.ts";
import { createWebSearchHandler } from "../../packages/butler-agent/src/agent/tools/web-search/index.ts";
import type { WebSearchProvider } from "../../packages/butler-agent/src/integrations/search/provider.ts";
import type { PageReadResult } from "../../packages/butler-agent/src/integrations/search/page-reader.ts";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(`${tmpdir()}/butler-evidence-web-`);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("web_search emits candidate discovery capability receipts only", async () => {
  const provider: WebSearchProvider = {
    id: "fixture-search",
    async search(input) {
      return {
        query: input.query,
        provider: "fixture-search",
        duration_ms: 4,
        usage: { search_requests: 1 },
        results: [{
          title: "Fixture Source",
          url: "https://example.com/source",
          snippet: "A source candidate.",
          source: "fixture",
        }],
      };
    },
  };
  const handler = createWebSearchHandler({ butlerData: tempDir, provider });
  const result = await handler({ args: { query: "current fixture", max_results: 1 } });
  const receipts = result.evidence_capability_receipts as unknown[];
  const ledger = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts,
  });

  expect(receipts).toHaveLength(1);
  expect(ledger.receipts[0]).toMatchObject({
    capability: "source_candidate",
    evidence_kind: "source_candidate",
    maturity: "candidate",
    verified: false,
  });
  expect(ledger.satisfied).toEqual([]);
  expect(ledger.missing).toEqual(["source_verified"]);
  expect(result.public_web_evidence_items).toEqual([
    expect.objectContaining({
      schema_version: "butler.public-web-evidence-item.v1",
      producer: "web_search",
      source_url: "https://example.com/source",
      source_identity: "example.com",
      content_kind: "search_snippet",
      published_at: null,
    }),
  ]);
});

test("web_search forwards the turn AbortSignal to its provider", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const provider: WebSearchProvider = {
    id: "abort-aware-search",
    async search(input) {
      receivedSignal = input.signal;
      throw input.signal?.reason;
    },
  };
  const handler = createWebSearchHandler({ butlerData: tempDir, provider });
  controller.abort(Object.assign(new Error("cancelled"), { name: "AbortError" }));
  await expect(
    handler({ args: { query: "cancel search" }, signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(receivedSignal).toBe(controller.signal);
});

test("web_search drops unsafe candidate URLs from capability references", async () => {
  const provider: WebSearchProvider = {
    id: "fixture-search",
    async search(input) {
      return {
        query: input.query,
        provider: "fixture-search",
        duration_ms: 4,
        usage: { search_requests: 1 },
        results: [{
          title: "Unsafe Source",
          url: "file:///private/butler/source.html",
          snippet: "A source candidate.",
          source: "fixture",
        }],
      };
    },
  };
  const handler = createWebSearchHandler({ butlerData: tempDir, provider });
  const result = await handler({ args: { query: "unsafe fixture", max_results: 1 } });
  const ledger = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts: result.evidence_capability_receipts as unknown[],
  });

  expect(ledger.rejectedReceipts).toEqual([]);
  expect(ledger.receipts[0].references).toEqual([]);
  expect(ledger.satisfied).toEqual([]);
});

test("web_read emits verified source capability receipts for successful reads", async () => {
  const handler = createWebReadHandler({
    butlerData: tempDir,
    pageReader: async (): Promise<PageReadResult> => ({
      reader: "butler-lightweight",
      requestedUrl: "https://example.com/source",
      finalUrl: "https://example.com/source",
      ok: true,
      status: 200,
      title: "Fixture Source",
      text: "Verified source text ".repeat(60),
      markdown: "Verified source markdown ".repeat(60),
      document: "Verified source document",
      chunks: [{
        id: "chunk-1",
        index: 0,
        title: "Fixture Source",
        url: "https://example.com/source",
        text: "Verified source text ".repeat(10),
        charCount: 210,
      }],
      method: "plain-text",
      durationMs: 3,
      warnings: [],
      renderRecommended: false,
    }),
  });
  const result = await handler({ args: { url: "https://example.com/source" } });
  const ledger = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts: result.evidence_capability_receipts as unknown[],
  });

  expect(ledger.rejectedReceipts).toEqual([]);
  expect(ledger.satisfied).toEqual(["source_verified"]);
  expect(ledger.missing).toEqual([]);
  expect(result.public_web_evidence_items).toEqual([
    expect.objectContaining({
      schema_version: "butler.public-web-evidence-item.v1",
      producer: "web_read",
      source_url: "https://example.com/source",
      source_identity: "example.com",
      content_kind: "page_chunk",
    }),
  ]);
});

test("web_read emits limitation receipts for failed reads", async () => {
  const handler = createWebReadHandler({
    butlerData: tempDir,
    pageReader: async (): Promise<PageReadResult> => ({
      reader: "disabled",
      requestedUrl: "https://example.com/source",
      finalUrl: "https://example.com/source",
      ok: false,
      text: "",
      markdown: "",
      document: "",
      chunks: [],
      method: "plain-text",
      durationMs: 2,
      warnings: ["reader disabled"],
      renderRecommended: false,
      error: "reader disabled",
    }),
  });
  const result = await handler({ args: { url: "https://example.com/source" } });
  const ledger = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts: result.evidence_capability_receipts as unknown[],
  });

  expect(ledger.receipts[0]).toMatchObject({
    capability: "limitation_recorded",
    evidence_kind: "limitation",
    maturity: "rejected",
    verified: false,
  });
  expect(ledger.satisfied).toEqual([]);
  expect(ledger.missing).toEqual(["source_verified"]);
});

test("web_read does not verify empty successful reads", async () => {
  const handler = createWebReadHandler({
    butlerData: tempDir,
    pageReader: async (): Promise<PageReadResult> => ({
      reader: "butler-lightweight",
      requestedUrl: "https://example.com/empty",
      finalUrl: "https://example.com/empty",
      ok: true,
      status: 200,
      title: "Empty Source",
      text: "",
      markdown: "",
      document: "",
      chunks: [],
      method: "plain-text",
      durationMs: 2,
      warnings: [],
      renderRecommended: false,
    }),
  });
  const result = await handler({ args: { url: "https://example.com/empty" } });
  const ledger = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts: result.evidence_capability_receipts as unknown[],
  });

  expect(ledger.receipts[0]).toMatchObject({
    capability: "limitation_recorded",
    evidence_kind: "limitation",
  });
  expect(ledger.satisfied).toEqual([]);
  expect(ledger.missing).toEqual(["source_verified"]);
});

test("web_read falls back to requested URL when reader returns unsafe final URL", async () => {
  const handler = createWebReadHandler({
    butlerData: tempDir,
    pageReader: async (): Promise<PageReadResult> => ({
      reader: "butler-lightweight",
      requestedUrl: "https://example.com/source",
      finalUrl: "file:///private/butler/source.html",
      ok: true,
      status: 200,
      title: "Fixture Source",
      text: "Verified source text ".repeat(60),
      markdown: "Verified source markdown ".repeat(60),
      document: "Verified source document",
      chunks: [{
        id: "chunk-1",
        index: 0,
        title: "Fixture Source",
        url: "file:///private/butler/source.html",
        text: "Verified source text ".repeat(10),
        charCount: 210,
      }],
      method: "plain-text",
      durationMs: 3,
      warnings: [],
      renderRecommended: false,
    }),
  });
  const result = await handler({ args: { url: "https://example.com/source" } });
  const ledger = buildEvidenceCapabilityLedger({
    required: ["source_verified"],
    receipts: result.evidence_capability_receipts as unknown[],
  });

  expect(ledger.rejectedReceipts).toEqual([]);
  expect(ledger.receipts[0].references).toEqual([{ url: "https://example.com/source" }]);
  expect(ledger.satisfied).toEqual(["source_verified"]);
});

test("web_read emits browser observation receipts for browser-backed reads", async () => {
  const handler = createWebReadHandler({
    butlerData: tempDir,
    pageReader: async (): Promise<PageReadResult> => ({
      reader: "lightpanda",
      requestedUrl: "https://example.com/source",
      finalUrl: "https://example.com/source",
      ok: true,
      status: 200,
      title: "Fixture Source",
      text: "Verified source text ".repeat(60),
      markdown: "Verified source markdown ".repeat(60),
      document: "Verified source document",
      chunks: [],
      method: "raw-html",
      durationMs: 3,
      warnings: ["viewport clipped"],
      renderRecommended: false,
    }),
  });
  const result = await handler({ args: { url: "https://example.com/source" } });
  const receipts = result.evidence_capability_receipts as Array<Record<string, unknown>>;

  expect(receipts.some((receipt) =>
    receipt.capability === "browser_observed" &&
    receipt.evidence_kind === "browser_observation" &&
    receipt.verified === true,
  )).toBe(true);
  expect(JSON.stringify(receipts)).toContain("viewport clipped");
});
