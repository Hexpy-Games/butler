import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { browserObservationCapabilityReceipt } from
  "../../../output/evidence/ledger.ts";
import { resolveWorkspacePathGuard } from
  "../../file-tools/shared/workspace-path-guard.ts";
import type { WorkspaceReference } from "../../../session-workspaces/index.ts";

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 90_000;

type PreviewToolCall = {
  args: Record<string, unknown>;
  signal?: AbortSignal;
};

export function createInspectWorkspacePageHandler(input: {
  butlerData: string;
  workspacePath: string;
  workspaceReference?: WorkspaceReference;
  endpoint?: string | null;
  authToken?: string | null;
  fetcher?: typeof fetch;
}) {
  return async (call: PreviewToolCall): Promise<Record<string, unknown>> => {
    const endpoint = localPreviewEndpoint(
      input.endpoint ?? process.env.BUTLER_APP_LOCAL_PAGE_PREVIEW_URL,
    );
    const token = input.authToken ?? readLocalAppAuthToken();
    if (!endpoint || !token) {
      return previewError(
        "workspace_page_preview_unavailable",
        "Actual page rendering is unavailable outside a running Butler App window. Continue with structural validation and disclose the visual limitation.",
      );
    }
    const entryPath = stringArg(call.args.entry_path);
    if (!entryPath) {
      return previewError(
        "workspace_page_entry_required",
        "inspect_workspace_page requires a workspace-relative HTML entry_path.",
      );
    }
    const guarded = await resolveWorkspacePathGuard({
      workspaceRoot: input.workspaceReference?.get() ?? input.workspacePath,
      relativePath: entryPath,
    });
    if (!guarded.ok || !guarded.realPath || !guarded.absolutePath) {
      return previewError(
        "workspace_page_entry_rejected",
        `The page entry is unavailable under the admitted workspace (${guarded.reason ?? "path_rejected"}).`,
      );
    }
    if (!/\.html?$/iu.test(guarded.realPath)) {
      return previewError(
        "workspace_page_entry_not_html",
        "inspect_workspace_page accepts an HTML entry file.",
      );
    }

    const fetcher = input.fetcher ?? fetch;
    const controller = new AbortController();
    const cancel = () => controller.abort(call.signal?.reason);
    call.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Workspace page preview timed out")),
      PREVIEW_TIMEOUT_MS,
    );
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspace_root: guarded.workspaceRoot,
          entry_path: relative(guarded.workspaceRoot, guarded.realPath),
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object") {
        return previewError(
          "workspace_page_preview_failed",
          `Butler App could not render the page (HTTP ${response.status}).`,
        );
      }
      return publishPreviewResult({
        body: body as Record<string, unknown>,
        butlerData: input.butlerData,
        entryPath,
      });
    } catch (error) {
      if (call.signal?.aborted) throw error;
      return previewError(
        "workspace_page_preview_failed",
        error instanceof Error ? error.message : "Butler App could not render the page.",
      );
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener("abort", cancel);
    }
  };
}

export function workspacePagePreviewAvailabilityOverride(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    localPreviewEndpoint(env.BUTLER_APP_LOCAL_PAGE_PREVIEW_URL) &&
    readLocalAppAuthToken(env.BUTLER_APP_LOCAL_AUTH_FILE)
  ) return null;
  return {
    disabledReason:
      "Actual workspace page rendering requires the foreground Butler App preview host.",
    recoveryHint:
      "Open the project in Butler App, or use build and structural validation while clearly disclosing that visual inspection was unavailable.",
  } as const;
}

function publishPreviewResult(input: {
  body: Record<string, unknown>;
  butlerData: string;
  entryPath: string;
}): Record<string, unknown> {
  const sourceViews = Array.isArray(input.body.viewports)
    ? input.body.viewports
    : [];
  const outputRoot = join(
    input.butlerData,
    "artifacts",
    "generated",
    `page-preview-${randomUUID()}`,
  );
  const views: Record<string, unknown>[] = [];
  const modelAttachments: Array<{
    path: string;
    media_type: "image/jpeg";
    name: string;
  }> = [];
  const publishedViewportNames = new Set<string>();
  for (const candidate of sourceViews.slice(0, 2)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const view = candidate as Record<string, unknown>;
    const name = view.name === "mobile" ? "mobile" : "desktop";
    if (publishedViewportNames.has(name)) continue;
    publishedViewportNames.add(name);
    const screenshotPaths: string[] = [];
    const publishedPositions = new Set<string>();
    const screenshots = Array.isArray(view.screenshots) ? view.screenshots : [];
    for (const value of screenshots.slice(0, 2)) {
      const screenshot = imagePayload(value);
      const position = screenshotPosition(value);
      if (!screenshot || !position || publishedPositions.has(position)) continue;
      publishedPositions.add(position);
      const bytes = Buffer.from(screenshot.base64, "base64");
      if (bytes.length > 0 && bytes.length <= MAX_SCREENSHOT_BYTES) {
        mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
        const absolutePath = join(outputRoot, `${name}-${position}.jpg`);
        writeFileSync(absolutePath, bytes, { mode: 0o600 });
        const artifactPath = relative(input.butlerData, absolutePath)
          .split("\\").join("/");
        screenshotPaths.push(artifactPath);
        modelAttachments.push({
          path: artifactPath,
          media_type: "image/jpeg",
          name: `${name} ${position} workspace page preview`,
        });
      }
    }
    views.push({
      name,
      requested_width: finiteNumber(view.requested_width),
      requested_height: finiteNumber(view.requested_height),
      inner_width: finiteNumber(view.inner_width),
      client_width: finiteNumber(view.client_width),
      scroll_width: finiteNumber(view.scroll_width),
      scroll_height: finiteNumber(view.scroll_height),
      body_text_length: finiteNumber(view.body_text_length),
      hidden_text_elements: finiteNumber(view.hidden_text_elements),
      screenshot_truncated: view.screenshot_truncated === true,
      horizontal_overflow: typeof view.horizontal_overflow === "boolean"
        ? view.horizontal_overflow
        : null,
      loaded: view.loaded === true,
      console_errors: stringArray(view.console_errors, 20, 500),
      blocked_external_requests: finiteNumber(view.blocked_external_requests),
      screenshot_paths: screenshotPaths,
      error: typeof view.error === "string" ? view.error.slice(0, 500) : null,
    });
  }
  const observed = ["desktop", "mobile"].every((name) => views.some((view) =>
    view.name === name && view.loaded === true &&
    Array.isArray(view.screenshot_paths) && view.screenshot_paths.length > 0,
  ));
  const limitations = views.flatMap((view) => {
    const values = [];
    if (view.horizontal_overflow === true) values.push(`${view.name} has horizontal overflow.`);
    if (Array.isArray(view.console_errors) && view.console_errors.length > 0) {
      values.push(`${view.name} reported browser console errors.`);
    }
    if (view.screenshot_truncated === true) {
      values.push(`${view.name} visual evidence samples the top and bottom of a long page.`);
    }
    if (typeof view.error === "string" && view.error) values.push(`${view.name}: ${view.error}`);
    return values;
  });
  return {
    ok: observed,
    entry_path: input.entryPath,
    viewports: views,
    visual_evidence_attached: modelAttachments.length > 0,
    model_image_attachments: modelAttachments,
    evidence_capability_receipts: [browserObservationCapabilityReceipt({
      producer: { kind: "tool", name: "inspect_workspace_page" },
      result: observed ? "observed" : views.length > 0 ? "partial" : "failed",
      observation: observed
        ? "The workspace page was rendered at desktop and mobile sizes."
        : "The workspace page preview did not fully render.",
      references: modelAttachments.map((attachment) => ({
        label: attachment.name,
        path: attachment.path,
      })),
      limitations,
    })],
  };
}

function readLocalAppAuthToken(
  explicitPath = process.env.BUTLER_APP_LOCAL_AUTH_FILE,
): string | null {
  if (!explicitPath || !isAbsolute(explicitPath) || !existsSync(explicitPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(explicitPath, "utf8"));
    return typeof parsed?.token === "string" && parsed.token.length >= 32
      ? parsed.token
      : null;
  } catch {
    return null;
  }
}

function localPreviewEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
      url.pathname !== "/v1/preview"
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function imagePayload(value: unknown): {
  mediaType: "image/jpeg";
  base64: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.media_type !== "image/jpeg" || typeof record.base64 !== "string") return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(record.base64)) return null;
  return { mediaType: "image/jpeg", base64: record.base64 };
}

function screenshotPosition(value: unknown): "top" | "bottom" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const position = (value as Record<string, unknown>).position;
  return position === "top" || position === "bottom" ? position : null;
}

function previewError(code: string, message: string): Record<string, unknown> {
  return {
    ok: false,
    error: { code, message: message.slice(0, 500), recoverable: true },
    evidence_capability_receipts: [browserObservationCapabilityReceipt({
      producer: { kind: "tool", name: "inspect_workspace_page" },
      result: "failed",
      observation: "The workspace page could not be observed in a browser.",
      limitations: [message.slice(0, 500)],
    })],
  };
}

function stringArg(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown, limit: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
      .slice(0, limit)
      .map((item) => item.slice(0, maxLength))
    : [];
}
