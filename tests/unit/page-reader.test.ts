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
    }) as unknown as typeof fetch,
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
  }) as typeof fetch;
}

describe("lightweight page reader", () => {
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

  test("exports small text helpers for benchmark compatibility", () => {
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
