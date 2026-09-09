import { describe, expect, test } from "bun:test";
import {
  buildEvidenceDocument,
  chunkEvidence,
  configuredPageReaderBackend,
  githubRawUrl,
  normalizePageReaderBackend,
  readPageConfigured,
  readPageLightpanda,
  readPageLightweight,
  shouldRecommendRender,
  stripHtmlToText,
} from "../../packages/butler-agent/src/integrations/search/page-reader.ts";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { textPdf } from "../fixtures/text-pdf.ts";

function response(body: string, options: {
  url?: string;
  status?: number;
  contentType?: string;
} = {}): Response {
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "text/html; charset=utf-8",
    },
  }) as Response & { url: string };
}

test("lightweight page reader forwards AbortSignal into fetch", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null = null;
  const pending = readPageLightweight({
    url: "https://example.test/pending",
    signal: controller.signal,
    fetchImpl: (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      receivedSignal = init?.signal as AbortSignal;
      await new Promise<void>((_resolve, reject) => {
        receivedSignal?.addEventListener(
          "abort",
          () => reject(receivedSignal?.reason),
          { once: true },
        );
      });
      throw new Error("unreachable");
    }) as unknown as unknown as typeof fetch,
  });
  controller.abort(Object.assign(new Error("cancelled"), { name: "AbortError" }));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect((receivedSignal as AbortSignal | null)?.aborted).toBe(true);
});

function fetchMap(fixtures: Record<string, Response>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = String(url);
    const fixture = fixtures[key];
    if (!fixture) throw new Error(`missing fixture: ${key}`);
    Object.defineProperty(fixture, "url", {
      value: key,
      configurable: true,
    });
    return fixture;
  }) as unknown as typeof fetch;
}

describe("lightweight page reader", () => {
  test("dispatches normalized textual MIME without treating XML as HTML", async () => {
    for (const [contentType, body, method] of [
      ["Application/Xhtml+Xml; charset=UTF-8", "<html><title>XHTML</title><body><p>Readable XHTML content.</p></body></html>", "readability"],
      ["Application/JSON; charset=UTF-8", '{"message":"Plain JSON"}', "plain-text"],
      ["application/xml", "<report><value>Preserved XML</value></report>", "plain-text"],
    ] as const) {
      const result = await readPageLightweight({ url: "https://example.test/document", fetchImpl: (async () => response(body, { contentType })) as unknown as typeof fetch });
      expect(result.ok).toBe(true);
      expect(result.method).toBe(method);
      if (method === "plain-text") expect(result.text).toBe(body);
    }
  });

  test("sniffs PDF bytes under generic MIME and rejects unknown binary without rendering", async () => {
    const pdf = await readPageLightweight({
      url: "https://example.test/download",
      fetchImpl: (async () => new Response(textPdf(["First page evidence.", "Second page evidence."]), { headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch,
    });
    expect(pdf).toMatchObject({ ok: true, method: "pdf", title: "Butler PDF Evidence", renderRecommended: false });
    expect(pdf.text).toContain("First page evidence.\n\n---\n\nSecond page evidence.");
    const binary = await readPageConfigured({
      butlerData: "/tmp/unused", backend: "auto", url: "https://example.test/not-really.pdf",
      fetchImpl: (async () => new Response(new Uint8Array([0, 255, 23, 0]), { headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch,
    });
    expect(binary).toMatchObject({ ok: false, method: "unsupported", renderRecommended: false, chunks: [] });
    expect(binary.warnings).toEqual(["unsupported-document-type"]);
  });

  test("deadline cancels response body consumption", async () => {
    let cancelled = false;
    const result = await readPageLightweight({
      url: "https://example.test/slow-body", timeoutMs: 30,
      fetchImpl: (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))) as unknown as typeof fetch,
    });
    expect(cancelled).toBe(true);
    expect(result).toMatchObject({ ok: false, renderRecommended: false });
    expect(result.error).toContain("timed out");
  });

  test("terminates actual large HTML parsing on timeout and cancellation", async () => {
    const html = `<html><body>${"<article><p>Substantial article evidence for parsing cancellation.</p></article>".repeat(100_000)}</body></html>`;
    const fetchImpl = (async () => response(html)) as unknown as typeof fetch;
    const started = Date.now();
    const timedOut = await readPageLightweight({ url: "https://example.test/large", fetchImpl, timeoutMs: 1_200 });
    expect(timedOut).toMatchObject({ ok: false, renderRecommended: false });
    expect(timedOut.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(3_000);
    const controller = new AbortController();
    const cancel = setTimeout(() => controller.abort(new DOMException("Parsing cancelled", "AbortError")), 1_200);
    const cancelStarted = Date.now();
    try {
      await expect(readPageLightweight({ url: "https://example.test/large", fetchImpl, signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(Date.now() - cancelStarted).toBeLessThan(3_000);
    } finally {
      clearTimeout(cancel);
    }
  }, 8_000);

  test("extracts static HTML text without Docker or browser state", async () => {
    const result = await readPageLightweight({
      url: "https://example.test",
      fetchImpl: fetchMap({
        "https://example.test": response(`
          <html>
            <head><title>Example Domain</title></head>
            <body><main><h1>Example Domain</h1><p>${"Used for documentation examples. ".repeat(4)}</p></main></body>
          </html>
        `),
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.title).toContain("Example Domain");
    expect(result.text).toContain("documentation examples");
    expect(result.markdown).toContain("documentation examples");
    expect(result.document).toContain("URL Source: https://example.test");
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.renderRecommended).toBe(false);
  });

  test("uses readability for article-like pages", async () => {
    const result = await readPageLightweight({
      url: "https://news.test/story",
      fetchImpl: fetchMap({
        "https://news.test/story": response(`
          <html>
            <head><title>Story</title></head>
            <body>
              <nav>menu menu menu</nav>
              <article>
                <h1>Research Story</h1>
                <p>${"Important evidence ".repeat(80)}</p>
              </article>
            </body>
          </html>
        `),
      }),
    });

    expect(result.method).toBe("readability");
    expect(result.markdown).toContain("# Research Story");
    expect(result.text).toContain("Important evidence");
    expect(result.text).not.toContain("menu menu menu");
  });

  test("converts GitHub blob URLs to raw content when page chrome is noisy", async () => {
    const blobUrl = "https://github.com/facebook/react/blob/main/packages/react/src/ReactHooks.js";
    const rawUrl = "https://raw.githubusercontent.com/facebook/react/main/packages/react/src/ReactHooks.js";
    const result = await readPageLightweight({
      url: blobUrl,
      fetchImpl: fetchMap({
        [blobUrl]: response("<html><body>Sign in to GitHub</body></html>"),
        [rawUrl]: response("export function useEffect() { return resolveDispatcher().useEffect(); }", {
          contentType: "text/plain; charset=utf-8",
        }),
      }),
    });

    expect(githubRawUrl(blobUrl)).toBe(rawUrl);
    expect(result.method).toBe("github-raw");
    expect(result.text).toContain("resolveDispatcher");
    expect(result.markdown).toContain("```");
    expect(result.renderRecommended).toBe(false);
  });

  test("flags CSR app shells for browser rendering fallback", async () => {
    const scripts = Array.from({ length: 9 }, (_, index) => `<script src="/${index}.js"></script>`).join("");
    const result = await readPageLightweight({
      url: "https://app.test",
      fetchImpl: fetchMap({
        "https://app.test": response(`<html><body><div id="root"></div>${scripts}Please enable JavaScript.</body></html>`),
      }),
    });

    expect(result.warnings).toContain("likely-csr-app-shell");
    expect(result.warnings).toContain("javascript-required");
    expect(result.renderRecommended).toBe(true);
  });

  test("flags Cloudflare challenge pages instead of treating boilerplate as evidence", async () => {
    const result = await readPageLightweight({
      url: "https://docs.test",
      fetchImpl: fetchMap({
        "https://docs.test": response(`
          <html>
            <head><title>Just a moment...</title></head>
            <body>
              <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
              <div>Verification successful. Waiting for docs.test to respond</div>
            </body>
          </html>
        `),
      }),
    });

    expect(result.warnings).toContain("cloudflare-challenge");
    expect(result.renderRecommended).toBe(true);
  });

  test("exports small text helpers for callers", () => {
    expect(stripHtmlToText("<p>A&nbsp;&amp;&nbsp;B</p>")).toBe("A & B");
    expect(shouldRecommendRender({
      text: "tiny",
      method: "raw-html",
      warnings: [],
    })).toBe(true);
    expect(shouldRecommendRender({
      text: "Loading... Add To Cart Product Details Loading...",
      method: "readability",
      warnings: ["tiny-content"],
    })).toBe(true);
  });

  test("builds deterministic LLM-friendly evidence chunks and document previews", () => {
    const chunks = chunkEvidence({
      url: "https://docs.test/page",
      title: "Docs",
      markdown: `# Heading\n\n${"Useful evidence sentence. ".repeat(140)}`,
      chunkSize: 500,
      overlap: 40,
    });
    const again = chunkEvidence({
      url: "https://docs.test/page",
      title: "Docs",
      markdown: `# Heading\n\n${"Useful evidence sentence. ".repeat(140)}`,
      chunkSize: 500,
      overlap: 40,
    });
    const document = buildEvidenceDocument({
      title: "Docs",
      url: "https://docs.test/page",
      method: "readability",
      markdown: "# Heading\n\nUseful evidence sentence.",
      warnings: [],
      chunks,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.id)).toEqual(again.map((chunk) => chunk.id));
    expect(document).toContain("Markdown Content:");
    expect(document).toContain("Evidence Chunks:");
    expect(document).toContain(chunks[0]!.id);
  });

  test("normalizes configured reader backend choices", () => {
    expect(normalizePageReaderBackend(undefined)).toBe("lightweight");
    expect(normalizePageReaderBackend("LIGHTWEIGHT")).toBe("lightweight");
    expect(normalizePageReaderBackend("jina-hosted")).toBe("jina-hosted");
    expect(normalizePageReaderBackend("unknown")).toBe("lightweight");
  });

  test("reads reader backend from Butler config with lightweight default", () => {
    const tempDir = join(tmpdir(), `butler-reader-config-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      expect(configuredPageReaderBackend({ butlerData: tempDir })).toBe("lightweight");
      writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
        webSearch: {
          readerBackend: "lightweight",
        },
      }));
      expect(configuredPageReaderBackend({ butlerData: tempDir })).toBe("lightweight");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("configured lightpanda reader safely falls back to lightweight when unavailable", async () => {
    const tempDir = join(tmpdir(), `butler-reader-lightpanda-${Date.now()}-${Math.random()}`);
    const originalBin = process.env.BUTLER_LIGHTPANDA_BIN;
    process.env.BUTLER_LIGHTPANDA_BIN = join(tempDir, "missing-lightpanda");
    mkdirSync(tempDir, { recursive: true });
    try {
      writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
        webSearch: {
          readerBackend: "lightpanda",
        },
      }));
      const scripts = Array.from({ length: 9 }, (_, index) => `<script src="/${index}.js"></script>`).join("");
      const result = await readPageConfigured({
        butlerData: tempDir,
        url: "https://app.test",
        fetchImpl: fetchMap({
          "https://app.test": response(`<html><body><div id="root"></div>${scripts}Please enable JavaScript.</body></html>`),
        }),
      });

      expect(result.reader).toBe("butler-lightweight");
      expect(result.renderRecommended).toBe(true);
      expect(result.warnings).toContain("lightpanda-unavailable-fell-back-to-lightweight");
      expect(result.document).toContain("lightpanda-unavailable-fell-back-to-lightweight");
    } finally {
      if (originalBin === undefined) {
        delete process.env.BUTLER_LIGHTPANDA_BIN;
      } else {
        process.env.BUTLER_LIGHTPANDA_BIN = originalBin;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("configured lightpanda reader retries CSR shells with rendered HTML", async () => {
    const tempDir = join(tmpdir(), `butler-reader-lightpanda-render-${Date.now()}-${Math.random()}`);
    const originalBin = process.env.BUTLER_LIGHTPANDA_BIN;
    mkdirSync(tempDir, { recursive: true });
    const binary = join(tempDir, "lightpanda");
    writeFileSync(binary, [
      "#!/usr/bin/env bash",
      "cat <<'HTML'",
      "<html><head><title>Rendered App</title></head><body><main><h1>Rendered App</h1><p>",
      "Campfire commerce inventory order checkout customer account ".repeat(40),
      "</p></main></body></html>",
      "HTML",
    ].join("\n"));
    chmodSync(binary, 0o755);
    process.env.BUTLER_LIGHTPANDA_BIN = binary;
    try {
      writeFileSync(join(tempDir, "butler.config.json"), JSON.stringify({
        webSearch: {
          readerBackend: "lightpanda",
        },
      }));
      const scripts = Array.from({ length: 9 }, (_, index) => `<script src="/${index}.js"></script>`).join("");
      const result = await readPageConfigured({
        butlerData: tempDir,
        url: "https://app.test",
        fetchImpl: fetchMap({
          "https://app.test": response(`<html><body><div id="root"></div>${scripts}Please enable JavaScript.</body></html>`),
        }),
      });

      expect(result.reader).toBe("lightpanda");
      expect(result.ok).toBe(true);
      expect(result.text).toContain("Campfire commerce");
      expect(result.document).toContain("Reader: lightpanda");
      expect(result.warnings).toContain("lightpanda-rendered-fallback-used");
    } finally {
      if (originalBin === undefined) {
        delete process.env.BUTLER_LIGHTPANDA_BIN;
      } else {
        process.env.BUTLER_LIGHTPANDA_BIN = originalBin;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("lightpanda reader reports render failure without treating it as evidence", async () => {
    const tempDir = join(tmpdir(), `butler-reader-lightpanda-fail-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
    const binary = join(tempDir, "lightpanda");
    writeFileSync(binary, "#!/usr/bin/env bash\necho nope >&2\nexit 7\n");
    chmodSync(binary, 0o755);
    try {
      const result = await readPageLightpanda({
        binary,
        url: "https://app.test",
        timeoutMs: 1_000,
      });

      expect(result.reader).toBe("lightpanda");
      expect(result.ok).toBe(false);
      expect(result.warnings).toContain("lightpanda-render-failed");
      expect(result.error).toContain("exit 7");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("configured disabled reader returns explicit disabled result", async () => {
    const result = await readPageConfigured({
      butlerData: "/tmp/does-not-matter",
      backend: "disabled",
      url: "https://example.test",
      fetchImpl: fetchMap({}),
    });

    expect(result.ok).toBe(false);
    expect(result.reader).toBe("disabled");
    expect(result.warnings).toContain("page-reader-disabled");
  });
});
