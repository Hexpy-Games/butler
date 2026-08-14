import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInspectWorkspacePageHandler,
  workspacePagePreviewAvailabilityOverride,
} from
  "../../packages/butler-agent/src/agent/tools/workspace-page-preview/inspect_workspace_page/executor.ts";

test("workspace page preview publishes bounded desktop and mobile image evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-page-preview-"));
  const workspace = join(root, "workspace");
  const butlerData = join(root, "data");
  mkdirSync(workspace, { recursive: true });
  await Bun.write(join(workspace, "index.html"), "<main>Preview</main>");
  const calls: Array<Record<string, unknown>> = [];
  const handler = createInspectWorkspacePageHandler({
    butlerData,
    workspacePath: workspace,
    endpoint: "http://127.0.0.1:29991/v1/preview",
    authToken: "a".repeat(43),
    fetcher: (async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      calls.push({
        authorization: (init?.headers as Record<string, string>).authorization,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        ok: true,
        viewports: [
          viewport("desktop", 1_440, 900),
          viewport("mobile", 390, 844),
        ],
      });
    }) as unknown as typeof fetch,
  });

  try {
    const result = await handler({
      args: { entry_path: "index.html" },
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([{
      authorization: `Bearer ${"a".repeat(43)}`,
      body: {
        workspace_root: realpathSync.native(workspace),
        entry_path: "index.html",
      },
    }]);
    expect(result).toMatchObject({
      ok: true,
      entry_path: "index.html",
      visual_evidence_attached: true,
      viewports: [
        { name: "desktop", loaded: true, horizontal_overflow: false },
        { name: "mobile", loaded: true, horizontal_overflow: false },
      ],
      model_image_attachments: [
        { media_type: "image/jpeg", name: "desktop top workspace page preview" },
        { media_type: "image/jpeg", name: "mobile top workspace page preview" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("/9j/2Q==");
    for (const attachment of result.model_image_attachments as Array<{ path: string }>) {
      const path = join(butlerData, attachment.path);
      expect(existsSync(path)).toBe(true);
      expect(attachment.path).toEndWith("-top-model.jpg");
      expect(readFileSync(path)).toEqual(Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace page preview rejects paths outside the admitted workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-page-preview-path-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(root, "outside.html"), "outside");
  await Bun.write(join(workspace, "index.html"), "inside");
  let fetched = false;
  const handler = createInspectWorkspacePageHandler({
    butlerData: join(root, "data"),
    workspacePath: workspace,
    endpoint: "http://127.0.0.1:29991/v1/preview",
    authToken: "b".repeat(43),
    fetcher: (async () => {
      fetched = true;
      return Response.json({});
    }) as unknown as typeof fetch,
  });
  try {
    expect(await handler({ args: { entry_path: "../outside.html" } }))
      .toMatchObject({
        ok: false,
        error: { code: "workspace_page_entry_rejected" },
      });
    expect(fetched).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace page preview advertises the missing App host as unavailable", () => {
  expect(workspacePagePreviewAvailabilityOverride({})).toMatchObject({
    disabledReason: expect.stringContaining("foreground Butler App"),
  });
});

function viewport(name: "desktop" | "mobile", width: number, height: number) {
  return {
    name,
    requested_width: width,
    requested_height: height,
    inner_width: width,
    client_width: width,
    scroll_width: width,
    scroll_height: height * 3,
    body_text_length: 100,
    hidden_text_elements: 0,
    horizontal_overflow: false,
    loaded: true,
    console_errors: [],
    blocked_external_requests: 0,
    screenshot_truncated: true,
    screenshots: [
      {
        position: "top",
        media_type: "image/jpeg",
        base64: "/9j/2Q==",
        model_base64: "/9gB/9k=",
      },
      { position: "bottom", media_type: "image/jpeg", base64: "/9j/2Q==" },
    ],
    error: null,
  };
}
