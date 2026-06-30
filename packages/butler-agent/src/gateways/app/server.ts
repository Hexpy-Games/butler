import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import {
  APP_PROTOCOL_VERSION,
  apiEnvelope,
  apiError,
  isCreateAutomationRequest,
  isCreateProjectRequest,
  isCreateSessionRequest,
  isHostedModelRegistrationRequest,
  isLocalModelDiscoveryRequest,
  isLocalModelRegistrationRequest,
  isLocalModelUpdateRequest,
  isMessageSendRequest,
  isMcpServerUpsertRequest,
  isProviderCredentialUpsertRequest,
  isQueueMessageRequest,
  isPersonalizationProfileMigrationRequest,
  isUpdateApplyRequest,
  isUpdateCheckRequest,
  isSessionControlUpdateRequest,
  isUpdateSessionRequest,
  isUpdateSettingsRequest,
  isUpdatePersonalizationRequest,
  type AutomationDetailView,
  type AutomationListView,
  type AutomationMutationResult,
  type AutomationRunListView,
  type AutomationRunResult,
  type ArchiveListView,
  type CommandPaletteView,
  type ContextDetailsView,
  type CreateProjectResult,
  type CreateSessionRequest,
  type CreateSessionResult,
  type AppEventEnvelope,
  type AppInfoView,
  type EventReplayView,
  type HealthView,
  type HostedModelDeletionResult,
  type HostedModelRegistrationResult,
  type LocalModelDiscoveryResult,
  type LocalModelDeletionResult,
  type LocalModelRegistrationResult,
  type McpCapabilitiesView,
  type McpServerDeleteResult,
  type McpServerListView,
  type McpServerMutationResult,
  type MessageListView,
  type MessageFileUploadResult,
  type ModelCatalogView,
  type NavigationView,
  type NewChatBriefingView,
  type PersonalizationView,
  type PersonalizationProfileMigrationPromptView,
  type PersonalizationProfileMigrationResultView,
  type ProjectActionResult,
  type ProjectDashboardView,
  type ProjectListView,
  type ProjectSessionListView,
  type ProviderCredentialMutationResult,
  type SessionControlsView,
  type SessionActionResult,
  type SessionSummaryView,
  type SessionView,
  type SessionListView,
  type SessionQueueView,
  type SettingsView,
  type SkillImportResult,
  type SkillSettingsView,
  type SystemEventListView,
  type TurnListView,
  type TranscriptExportView,
  type UsageMonitorView,
  type UpdateApplyResult,
  type UpdateQueuedMessageRequest,
  type UpdateStatusView,
  type WorkerActivityControlRequest,
  type WorkerActivityControlResult,
  type WorkerActivityListView,
  type WorkerActivitySummary,
} from "./protocol.ts";
import { profileThirdPartyMigrationPrompt } from "../../personalization/profiling.ts";
import { safeGeneratedSessionTitle } from "../../agent/output/session-title.ts";
import { runPromptText } from "../../integrations/providers/provider.ts";
import {
  AppResponderTimeoutError,
  AppServerStore,
  AppStoreOperationError,
  type AppMessageResponder,
} from "./store.ts";
import type { ButlerServiceClient } from "../core/client.ts";

export interface CreateAppServerOptions {
  dbPath?: string;
  butlerData?: string;
  butlerHome?: string;
  appVersion?: string;
  appUpdateManifest?: string;
  serverUrl?: string;
  bridgeMode?: "local" | "external";
  projectWorkspaceRoot?: string;
  folderSelectionSecret?: string;
  port?: number;
  hostname?: string;
  uiRoot?: string;
  devCorsOrigin?: string;
  responder?: AppMessageResponder;
  responderTimeoutMs?: number;
  serviceClient?: ButlerServiceClient;
  messageRateLimit?: MessageRateLimitOptions;
  automationSchedulerIntervalMs?: number | false;
  localAuth?: {
    required?: boolean;
    token?: string | null;
  };
}

interface LocalAuthConfig {
  required: boolean;
  token: string | null;
}

export interface AppServerHandle {
  url: string;
  stop(): void;
  store: AppServerStore;
}

const SESSION_CREATE_TITLE_TIMEOUT_MS = 20_000;
const SESSION_TITLE_INSTRUCTIONS = [
  "Generate one safe chat session title.",
  "Return only the title, in the user's language.",
  "Keep it concise: normally 2 to 8 words, no quotes, no markdown, no trailing period.",
  "Do not include secrets, raw prompts, tool names, or internal ids.",
].join(" ");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const STATIC_SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* http://localhost:*",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
} as const;

const DEFAULT_RESPONDER_TIMEOUT_MS = 600_000;
// Bun rejects idleTimeout values above 255, so keep direct HTTP requests at
// Bun's maximum while the responder timeout budget remains configurable.
const MAX_BUN_IDLE_TIMEOUT_SECONDS = 255;
const DEFAULT_MESSAGE_RATE_LIMIT = {
  max: 60,
  windowMs: 60_000,
} as const;
const DEFAULT_DEV_CORS_ORIGIN = "http://127.0.0.1:5173";
interface DevCorsPolicy {
  origins: Set<string>;
  allowLocalLoopback: boolean;
}

const MESSAGE_FILE_ID_PATTERN = /^file-[0-9a-f-]{36}$/iu;

export interface MessageRateLimitOptions {
  max?: number;
  windowMs?: number;
}

export function createAppServer(
  options: CreateAppServerOptions = {},
): AppServerHandle {
  const store = new AppServerStore({
    dbPath: options.dbPath,
    butlerData: options.butlerData,
    butlerHome: options.butlerHome,
    appVersion: options.appVersion,
    appUpdateManifest: options.appUpdateManifest,
    serverUrl: options.serverUrl,
    bridgeMode: options.bridgeMode,
    projectWorkspaceRoot: options.projectWorkspaceRoot,
    folderSelectionSecret: options.folderSelectionSecret,
    serviceClient: options.serviceClient,
  });
  const messageRateLimiter = new FixedWindowRateLimiter(
    options.messageRateLimit,
  );
  const port = options.port ?? 18765;
  const hostname = options.hostname ?? "127.0.0.1";
  const responderTimeoutMs =
    options.responderTimeoutMs ?? DEFAULT_RESPONDER_TIMEOUT_MS;
  const idleTimeout = Math.min(
    MAX_BUN_IDLE_TIMEOUT_SECONDS,
    Math.max(30, Math.ceil(responderTimeoutMs / 1000)),
  );
  const uiBaseRoot = options.butlerHome ?? process.cwd();
  const packagedUiRoot = resolve(uiBaseRoot, "packages", "butler-agent", "resources", "app-client", "dist");
  const builtUiRoot = resolve(uiBaseRoot, "packages", "butler-app", "client", "ui", "dist");
  const uiRoot =
    options.uiRoot ??
    (existsSync(packagedUiRoot)
      ? packagedUiRoot
      : existsSync(builtUiRoot)
      ? builtUiRoot
      : resolve(uiBaseRoot, "packages", "butler-app", "client", "ui"));
  const devCorsPolicy = normalizeDevCorsPolicy(options.devCorsOrigin);
  const localAuth = normalizeLocalAuth(options.localAuth);
  let automationSchedulerRunning = false;
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout,
    async fetch(request) {
      const corsHeaders = devCorsHeaders(request, devCorsPolicy);
      if (request.method === "OPTIONS" && Object.keys(corsHeaders).length > 0) {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders,
            "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-max-age": "600",
          },
        });
      }
      try {
        const response = await routeRequest({
          request,
          store,
          uiRoot,
          responder: options.responder,
          responderTimeoutMs,
          messageRateLimiter,
          localAuth,
        });
        return withExtraHeaders(response, corsHeaders);
      } catch (error) {
        if (error instanceof AppResponderTimeoutError) {
          return json(apiError(error.code, error.message), 504, corsHeaders);
        }
        if (error instanceof AppStoreOperationError) {
          return json(
            apiError(error.code, error.message),
            error.status,
            corsHeaders,
          );
        }
        if (error instanceof RequestError) {
          return json(
            apiError(error.code, error.message),
            error.status,
            corsHeaders,
          );
        }
        return json(
          apiError("internal_error", "Request failed."),
          500,
          corsHeaders,
        );
      }
    },
  });
  const automationSchedulerIntervalMs =
    options.automationSchedulerIntervalMs === false
      ? false
      : Math.max(1000, options.automationSchedulerIntervalMs ?? 30_000);
  const automationScheduler =
    automationSchedulerIntervalMs === false
      ? null
      : setInterval(() => {
          if (automationSchedulerRunning) return;
          automationSchedulerRunning = true;
          store
            .dispatchDueAutomations(options.responder, {
              responderTimeoutMs,
            })
            .catch((error) => {
              store.appendSafeServerEvent("automation.scheduler_error", {
                code:
                  error instanceof Error
                    ? "automation_scheduler_failed"
                    : "automation_scheduler_unknown",
              });
            })
            .finally(() => {
              automationSchedulerRunning = false;
            });
        }, automationSchedulerIntervalMs);

  return {
    url: server.url.toString(),
    store,
    stop() {
      if (automationScheduler) clearInterval(automationScheduler);
      server.stop();
      store.close();
    },
  };
}

async function createSessionInputWithGeneratedTitle(input: {
  body: CreateSessionRequest;
  requestSignal?: AbortSignal;
  store: AppServerStore;
}): Promise<CreateSessionRequest> {
  const generatedTitle = await generateTitleFromInitialMessage({
    initialMessage: input.body.initial_message,
    requestSignal: input.requestSignal,
    butlerData: input.store.butlerDataRoot(),
  });
  if (!generatedTitle) return input.body;
  return {
    ...input.body,
    title: generatedTitle,
  };
}

async function generateTitleFromInitialMessage(input: {
  initialMessage?: string;
  requestSignal?: AbortSignal;
  butlerData: string;
}): Promise<string | null> {
  const boundedText = input.initialMessage
    ?.replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1200);
  if (!boundedText || input.requestSignal?.aborted) return null;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SESSION_CREATE_TITLE_TIMEOUT_MS,
  );
  timeout.unref?.();
  const abort = () => controller.abort();
  input.requestSignal?.addEventListener("abort", abort, { once: true });

  try {
    const text = await runPromptText({
      prompt: `User message:\n${boundedText}`,
      model: await readConfiguredTitleModel(input.butlerData),
      instructions: SESSION_TITLE_INSTRUCTIONS,
      cacheScope: "app-session-create-title",
      signal: controller.signal,
      butlerData: input.butlerData,
    });
    if (controller.signal.aborted) return null;
    return safeGeneratedSessionTitle(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    input.requestSignal?.removeEventListener("abort", abort);
  }
}

async function readConfiguredTitleModel(
  butlerData: string,
): Promise<string | undefined> {
  try {
    const config = JSON.parse(
      await readFile(join(butlerData, "butler.config.json"), "utf8"),
    ) as Record<string, unknown>;
    const system = safeRecord(config.system);
    return safeString(system.butlerModel) ?? safeString(system.defaultModel);
  } catch {
    return undefined;
  }
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

async function routeRequest(input: {
  request: Request;
  store: AppServerStore;
  uiRoot: string;
  responder?: AppMessageResponder;
  responderTimeoutMs: number;
  messageRateLimiter: FixedWindowRateLimiter;
  localAuth: LocalAuthConfig;
}): Promise<Response> {
  const url = new URL(input.request.url);
  enforceLocalAuth(input.request, input.localAuth);

  if (
    input.request.method === "GET" &&
    (url.pathname === "/automations" || url.pathname.endsWith("/runs"))
  ) {
    await input.store.dispatchDueAutomations(input.responder, {
      responderTimeoutMs: input.responderTimeoutMs,
    });
  }

  if (input.request.method === "GET" && url.pathname === "/health") {
    return json(
      apiEnvelope<HealthView>({
        ok: true,
        service: "butler-app-server",
        protocol_version: APP_PROTOCOL_VERSION,
      }),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/chats") {
    return json(apiEnvelope(input.store.listChats()));
  }
  if (input.request.method === "GET" && url.pathname === "/navigation") {
    input.store.syncAllAppTransportEvents();
    return json(apiEnvelope<NavigationView>(input.store.listNavigation()));
  }
  if (input.request.method === "GET" && url.pathname === "/new-chat-briefing") {
    return json(
      apiEnvelope<NewChatBriefingView>(
        input.store.getNewChatBriefing({
          date: url.searchParams.get("date"),
          projectId: url.searchParams.get("project_id"),
        }),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/settings") {
    return json(apiEnvelope<SettingsView>(input.store.getSettings()));
  }
  if (input.request.method === "GET" && url.pathname === "/app-info") {
    return json(apiEnvelope<AppInfoView>(input.store.getAppInfo()));
  }
  if (input.request.method === "GET" && url.pathname === "/updates") {
    return json(apiEnvelope<UpdateStatusView>(await input.store.getUpdateStatus()));
  }
  if (input.request.method === "POST" && url.pathname === "/updates/check") {
    const body = await parseJson(input.request);
    if (!isUpdateCheckRequest(body)) {
      throw new RequestError(
        400,
        "invalid_update_check",
        "Update check request contains unsupported fields.",
      );
    }
    return json(apiEnvelope<UpdateStatusView>(await input.store.checkUpdates(body ?? {})));
  }
  if (input.request.method === "POST" && url.pathname === "/updates/apply") {
    const body = await parseJson(input.request);
    if (!isUpdateApplyRequest(body)) {
      throw new RequestError(
        400,
        "invalid_update_apply",
        "Update apply request requires a supported component.",
      );
    }
    return json(apiEnvelope<UpdateApplyResult>(await input.store.applyUpdate(body)));
  }
  if (input.request.method === "GET" && url.pathname === "/mcp-servers") {
    return json(apiEnvelope<McpServerListView>(input.store.listMcpServers()));
  }
  if (input.request.method === "GET" && url.pathname === "/mcp-capabilities") {
    return json(
      apiEnvelope<McpCapabilitiesView>(
        await input.store.listMcpCapabilities(),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/skills") {
    return json(apiEnvelope<SkillSettingsView>(input.store.getSkillSettings()));
  }
  if (input.request.method === "POST" && url.pathname === "/skills/import") {
    const form = await input.request.formData().catch(() => null);
    if (!form)
      throw new RequestError(
        400,
        "invalid_multipart",
        "Skill import must be multipart form data.",
      );
    const file = form.get("file");
    if (!isUploadFile(file))
      throw new RequestError(400, "file_required", "A file field is required.");
    const projectId = safeOptionalString(form.get("project_id"));
    return json(
      apiEnvelope<SkillImportResult>(
        input.store.importSkill({
          name: file.name,
          bytes: await file.arrayBuffer(),
          projectId,
        }),
      ),
      201,
    );
  }
  if (input.request.method === "POST" && url.pathname === "/mcp-servers") {
    const body = await parseJson(input.request);
    if (!isMcpServerUpsertRequest(body)) {
      throw new RequestError(
        400,
        "invalid_mcp_server_request",
        "MCP server request contains unsupported fields.",
      );
    }
    return json(
      apiEnvelope<McpServerMutationResult>(input.store.createMcpServer(body)),
      201,
    );
  }
  const mcpServerMatch = url.pathname.match(/^\/mcp-servers\/([^/]+)$/u);
  if (input.request.method === "PATCH" && mcpServerMatch) {
    const body = await parseJson(input.request);
    if (!isMcpServerUpsertRequest(body)) {
      throw new RequestError(
        400,
        "invalid_mcp_server_request",
        "MCP server request contains unsupported fields.",
      );
    }
    return json(
      apiEnvelope<McpServerMutationResult>(
        input.store.updateMcpServer(
          decodeURIComponent(mcpServerMatch[1]!),
          body,
        ),
      ),
    );
  }
  if (input.request.method === "DELETE" && mcpServerMatch) {
    return json(
      apiEnvelope<McpServerDeleteResult>(
        input.store.deleteMcpServer(decodeURIComponent(mcpServerMatch[1]!)),
      ),
    );
  }
  const mcpProbeMatch = url.pathname.match(/^\/mcp-servers\/([^/]+)\/probe$/u);
  if (input.request.method === "POST" && mcpProbeMatch) {
    return json(
      apiEnvelope<McpCapabilitiesView>(
        await input.store.probeMcpServer(
          decodeURIComponent(mcpProbeMatch[1]!),
        ),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/model-catalog") {
    return json(apiEnvelope<ModelCatalogView>(input.store.getModelCatalog()));
  }
  if (
    input.request.method === "POST" &&
    url.pathname === "/model-catalog/provider-credentials"
  ) {
    const body = await parseJson(input.request);
    if (!isProviderCredentialUpsertRequest(body)) {
      throw new RequestError(
        400,
        "invalid_provider_credential",
        "Provider credential registration requires provider id and API key.",
      );
    }
    return json(
      apiEnvelope<ProviderCredentialMutationResult>(
        input.store.upsertProviderCredential(body),
      ),
      201,
    );
  }
  if (
    input.request.method === "POST" &&
    url.pathname === "/model-catalog/registered-models"
  ) {
    const body = await parseJson(input.request);
    if (!isHostedModelRegistrationRequest(body)) {
      throw new RequestError(
        400,
        "invalid_hosted_model_registration",
        "Hosted model registration requires provider, model, and supported auth.",
      );
    }
    return json(
      apiEnvelope<HostedModelRegistrationResult>(
        input.store.registerHostedModel(body),
      ),
      201,
    );
  }
  const hostedModelMatch = url.pathname.match(
    /^\/model-catalog\/registered-models\/([^/]+(?:\/[^/]+)?)$/u,
  );
  if (input.request.method === "DELETE" && hostedModelMatch) {
    return json(
      apiEnvelope<HostedModelDeletionResult>(
        input.store.deleteHostedModel(
          decodeURIComponent(hostedModelMatch[1]!),
        ),
      ),
    );
  }
  if (
    input.request.method === "POST" &&
    url.pathname === "/model-catalog/local/discover"
  ) {
    const body = await parseJson(input.request);
    if (!isLocalModelDiscoveryRequest(body)) {
      throw new RequestError(
        400,
        "invalid_local_model_discovery",
        "Local model discovery requires provider, API type, platform, and server URL.",
      );
    }
    return json(
      apiEnvelope<LocalModelDiscoveryResult>(
        await input.store.discoverLocalModels(body),
      ),
    );
  }
  if (
    input.request.method === "POST" &&
    url.pathname === "/model-catalog/local-models"
  ) {
    const body = await parseJson(input.request);
    if (!isLocalModelRegistrationRequest(body)) {
      throw new RequestError(
        400,
        "invalid_local_model_registration",
        "Local model registration requires server URL, model id, and context window.",
      );
    }
    return json(
      apiEnvelope<LocalModelRegistrationResult>(
        input.store.registerLocalModel(body),
      ),
      201,
    );
  }
  const localModelMatch = url.pathname.match(
    /^\/model-catalog\/local-models\/([^/]+)$/u,
  );
  if (input.request.method === "PATCH" && localModelMatch) {
    const body = await parseJson(input.request);
    if (!isLocalModelUpdateRequest(body)) {
      throw new RequestError(
        400,
        "invalid_local_model_update",
        "Local model update requires server URL, model id, and context window.",
      );
    }
    return json(
      apiEnvelope<LocalModelRegistrationResult>(
        input.store.updateLocalModel(
          decodeURIComponent(localModelMatch[1]!),
          body,
        ),
      ),
    );
  }
  if (input.request.method === "DELETE" && localModelMatch) {
    return json(
      apiEnvelope<LocalModelDeletionResult>(
        input.store.deleteLocalModel(decodeURIComponent(localModelMatch[1]!)),
      ),
    );
  }
  if (input.request.method === "PATCH" && url.pathname === "/settings") {
    const body = await parseJson(input.request);
    if (!isUpdateSettingsRequest(body)) {
      throw new RequestError(
        400,
        "invalid_settings_request",
        "Settings update contains unsupported fields.",
      );
    }
    return json(apiEnvelope<SettingsView>(input.store.updateSettings(body)));
  }
  if (input.request.method === "GET" && url.pathname === "/personalization") {
    return json(
      apiEnvelope<PersonalizationView>(input.store.getPersonalization()),
    );
  }
  if (
    input.request.method === "GET" &&
    url.pathname === "/personalization/profile-import-prompt"
  ) {
    const locale = url.searchParams.get("locale") === "ko" ? "ko" : "en";
    return json(
      apiEnvelope<PersonalizationProfileMigrationPromptView>({
        locale,
        prompt: profileThirdPartyMigrationPrompt(locale),
        raw_profile_included: false,
      }),
    );
  }
  if (input.request.method === "PATCH" && url.pathname === "/personalization") {
    const body = await parseJson(input.request);
    if (!isUpdatePersonalizationRequest(body)) {
      throw new RequestError(
        400,
        "invalid_personalization_request",
        "Personalization update contains unsupported fields.",
      );
    }
    return json(
      apiEnvelope<PersonalizationView>(input.store.updatePersonalization(body)),
    );
  }
  if (
    input.request.method === "POST" &&
    url.pathname === "/personalization/profile-import"
  ) {
    const body = await parseJson(input.request);
    if (!isPersonalizationProfileMigrationRequest(body)) {
      throw new RequestError(
        400,
        "invalid_personalization_profile_import",
        "Profile import requires text and optional source/model.",
      );
    }
    return json(
      apiEnvelope<PersonalizationProfileMigrationResultView>(
        await input.store.importPersonalizationProfile(body),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/command-palette") {
    return json(
      apiEnvelope<CommandPaletteView>(
        input.store.searchCommandPalette(url.searchParams.get("query") ?? ""),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/archives") {
    return json(
      apiEnvelope<ArchiveListView>(
        input.store.listArchives(paginationFromSearchParams(url.searchParams)),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/system-events") {
    return json(
      apiEnvelope<SystemEventListView>(
        input.store.listSystemEvents(paginationFromSearchParams(url.searchParams)),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/usage-monitor") {
    return json(
      apiEnvelope<UsageMonitorView>(
        input.store.getUsageMonitor(usageMonitorFromSearchParams(url.searchParams)),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/projects") {
    return json(
      apiEnvelope<ProjectListView>(
        input.store.listProjects({
          includeSessions: url.searchParams.get("include_sessions") === "true",
        }),
      ),
    );
  }
  if (input.request.method === "POST" && url.pathname === "/projects") {
    const body = await parseJson(input.request);
    if (!isCreateProjectRequest(body)) {
      throw new RequestError(
        400,
        "invalid_request",
        "Project source is required.",
      );
    }
    return json(
      apiEnvelope<CreateProjectResult>(input.store.createProject(body)),
      201,
    );
  }
  const projectDashboardMatch =
    input.request.method === "GET"
      ? url.pathname.match(/^\/projects\/([^/]+)\/dashboard$/u)
      : null;
  if (projectDashboardMatch) {
    return json(
      apiEnvelope<ProjectDashboardView>(
        input.store.getProjectDashboard(
          decodeURIComponent(projectDashboardMatch[1]!),
        ),
      ),
    );
  }
  const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/u);
  if (input.request.method === "PATCH" && projectMatch) {
    const body = await parseJson(input.request);
    return json(
      apiEnvelope<ProjectActionResult>(
        input.store.updateProject(
          decodeURIComponent(projectMatch[1]!),
          body && typeof body === "object" ? body : {},
        ),
      ),
    );
  }
  const projectArchiveMatch =
    input.request.method === "POST"
      ? url.pathname.match(/^\/projects\/([^/]+)\/archive$/u)
      : null;
  if (projectArchiveMatch) {
    return json(
      apiEnvelope<ProjectActionResult>(
        input.store.archiveProject(decodeURIComponent(projectArchiveMatch[1]!)),
      ),
    );
  }
  const projectPinMatch =
    input.request.method === "POST"
      ? url.pathname.match(/^\/projects\/([^/]+)\/pin$/u)
      : null;
  if (projectPinMatch) {
    const body = await parseJson(input.request);
    const pinned =
      body &&
      typeof body === "object" &&
      "pinned" in body &&
      typeof body.pinned === "boolean"
        ? body.pinned
        : undefined;
    return json(
      apiEnvelope<ProjectActionResult>(
        input.store.pinProject(decodeURIComponent(projectPinMatch[1]!), pinned),
      ),
    );
  }
  if (input.request.method === "DELETE" && projectMatch) {
    return json(
      apiEnvelope<ProjectActionResult>(
        url.searchParams.get("permanent") === "true"
          ? input.store.deleteProjectPermanent(decodeURIComponent(projectMatch[1]!))
          : input.store.deleteProject(decodeURIComponent(projectMatch[1]!)),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/sessions") {
    const kind = url.searchParams.get("kind");
    const normalizedKind =
      kind === "chat" || kind === "project" ? kind : undefined;
    return json(
      apiEnvelope<SessionListView>(
        input.store.listSessions({
          kind: normalizedKind,
          projectId: url.searchParams.get("project_id") ?? undefined,
        }),
      ),
    );
  }
  if (input.request.method === "POST" && url.pathname === "/sessions") {
    const body = await parseJson(input.request);
    if (!isCreateSessionRequest(body))
      throw new RequestError(
        400,
        "invalid_request",
        "Session kind is required.",
      );
    const createInput = await createSessionInputWithGeneratedTitle({
      body,
      requestSignal: input.request.signal,
      store: input.store,
    });
    return json(
      apiEnvelope<CreateSessionResult>(input.store.createSession(createInput)),
      201,
    );
  }
  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/u);
  if (input.request.method === "PATCH" && sessionMatch) {
    const body = await parseJson(input.request);
    if (!isUpdateSessionRequest(body)) {
      throw new RequestError(
        400,
        "invalid_session_update",
        "Session update contains unsupported fields.",
      );
    }
    return json(
      apiEnvelope<SessionActionResult>(
        input.store.updateSession(decodeURIComponent(sessionMatch[1]!), body),
      ),
    );
  }
  const sessionArchiveMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/archive$/u,
  );
  if (input.request.method === "POST" && sessionArchiveMatch) {
    return json(
      apiEnvelope<SessionActionResult>(
        input.store.archiveSession(decodeURIComponent(sessionArchiveMatch[1]!)),
      ),
    );
  }
  if (input.request.method === "DELETE" && sessionMatch) {
    return json(
      apiEnvelope<SessionActionResult>(
        url.searchParams.get("permanent") === "true"
          ? input.store.deleteSessionPermanent(decodeURIComponent(sessionMatch[1]!))
          : input.store.archiveSession(decodeURIComponent(sessionMatch[1]!)),
      ),
    );
  }
  const sessionControlsMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/controls$/u,
  );
  if (input.request.method === "GET" && sessionControlsMatch) {
    return json(
      apiEnvelope<SessionControlsView>(
        input.store.getSessionControlsView(
          decodeURIComponent(sessionControlsMatch[1]!),
        ),
      ),
    );
  }
  if (input.request.method === "PATCH" && sessionControlsMatch) {
    const body = await parseJson(input.request);
    if (!isSessionControlUpdateRequest(body)) {
      throw new RequestError(
        400,
        "invalid_session_controls",
        "Session controls update contains unsupported fields.",
      );
    }
    return json(
      apiEnvelope<SessionControlsView>(
        input.store.updateSessionControlsView(
          decodeURIComponent(sessionControlsMatch[1]!),
          body,
        ),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/project-sessions") {
    return json(
      apiEnvelope<ProjectSessionListView>(
        input.store.listProjectSessions(
          url.searchParams.get("project_id") ?? undefined,
        ),
      ),
    );
  }
  if (input.request.method === "POST" && url.pathname === "/message-files") {
    const form = await input.request.formData().catch(() => null);
    if (!form)
      throw new RequestError(
        400,
        "invalid_multipart",
        "File upload must be multipart form data.",
      );
    const file = form.get("file");
    if (!isUploadFile(file))
      throw new RequestError(400, "file_required", "A file field is required.");
    const ownerSessionId = safeOptionalString(form.get("session_id"));
    const bytes = await file.arrayBuffer();
    return json(
      apiEnvelope<MessageFileUploadResult>(
        input.store.createMessageFile({
          ownerSessionId,
          name: file.name,
          mimeType: file.type,
          bytes,
        }),
      ),
      201,
    );
  }
  const messageFileMatch =
    input.request.method === "GET"
      ? url.pathname.match(/^\/message-files\/([^/]+)$/u)
      : null;
  if (messageFileMatch) {
    const fileId = decodeURIComponent(messageFileMatch[1]!);
    if (!MESSAGE_FILE_ID_PATTERN.test(fileId)) {
      throw new RequestError(
        404,
        "message_file_not_found",
        "Message file was not found.",
      );
    }
    const { file, bytes } = input.store.getMessageFileDownload(fileId);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": file.mime_type,
        "content-length": String(bytes.byteLength),
        "content-disposition": contentDispositionForAttachment(file.safe_name),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const sessionWorkerMatch =
    input.request.method === "GET"
      ? url.pathname.match(
          /^\/sessions\/([^/]+)\/worker-activity(?:\/history)?$/u,
        )
      : null;
  if (sessionWorkerMatch) {
    input.store.refreshSessionProjection(
      decodeURIComponent(sessionWorkerMatch[1]!),
    );
    return json(
      apiEnvelope<WorkerActivityListView>(
        input.store.listWorkerActivity({
          sessionId: decodeURIComponent(sessionWorkerMatch[1]!),
          includeHistory: url.pathname.endsWith("/history"),
        }),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/messages") {
    const chatId = url.searchParams.get("chat_id") ?? undefined;
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    const sessionId = chatId ?? "general";
    input.store.refreshSessionProjection(sessionId);
    const cursorFloor = Number.isFinite(cursor) ? cursor : 0;
    const view = input.store.getSessionView(sessionId);
    const messages = view.messages.filter(
      (message) => Number(message.cursor ?? 0) > cursorFloor,
    );
    return json(
      apiEnvelope<MessageListView>({
        chat_id: sessionId,
        messages,
        turn_progress:
          input.store.listTurnProgressSnapshotsForMessages(messages),
        next_cursor: maxCursor(
          messages.map((message) => message.cursor),
          cursorFloor,
        ),
      }),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/turns") {
    const chatId = url.searchParams.get("chat_id") ?? undefined;
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    input.store.refreshSessionProjection(chatId ?? "general");
    const turns = input.store.listTurns(
      chatId,
      Number.isFinite(cursor) ? cursor : 0,
    );
    return json(
      apiEnvelope<TurnListView>({
        chat_id: chatId ?? "general",
        turns,
        next_cursor:
          turns.at(-1)?.cursor ?? (Number.isFinite(cursor) ? cursor : 0),
      }),
    );
  }
  const turnRetryMatch =
    input.request.method === "POST"
      ? url.pathname.match(/^\/turns\/([^/]+)\/retry$/u)
      : null;
  if (turnRetryMatch) {
    return json(
      apiEnvelope(
        await input.store.retryTurn(
          decodeURIComponent(turnRetryMatch[1]!),
          input.responder,
          {
            responderTimeoutMs: input.responderTimeoutMs,
            deferResponderTurns: true,
          },
        ),
      ),
      202,
    );
  }
  const turnCancelMatch =
    input.request.method === "POST"
      ? url.pathname.match(/^\/turns\/([^/]+)\/cancel$/u)
      : null;
  if (turnCancelMatch) {
    return json(
      apiEnvelope(
        input.store.cancelTurn(decodeURIComponent(turnCancelMatch[1]!)),
      ),
      202,
    );
  }
  if (input.request.method === "GET" && url.pathname === "/session-queue") {
    const sessionId =
      url.searchParams.get("session_id") ??
      url.searchParams.get("sessionId") ??
      "general";
    return json(
      apiEnvelope<SessionQueueView>(input.store.listSessionQueue(sessionId)),
    );
  }
  if (input.request.method === "POST" && url.pathname === "/session-queue") {
    const body = await parseJson(input.request);
    if (!isQueueMessageRequest(body))
      throw new RequestError(
        400,
        "invalid_request",
        "Queued message text is required.",
      );
    return json(apiEnvelope(input.store.createQueuedMessage(body)), 202);
  }
  const queuedMessageMatch =
    input.request.method === "PATCH" || input.request.method === "DELETE"
      ? url.pathname.match(/^\/session-queue\/([^/]+)$/u)
      : null;
  if (queuedMessageMatch && input.request.method === "PATCH") {
    const body = await parseJson(input.request);
    return json(
      apiEnvelope(
        input.store.updateQueuedMessage(
          decodeURIComponent(queuedMessageMatch[1]!),
          body as UpdateQueuedMessageRequest,
        ),
      ),
    );
  }
  if (queuedMessageMatch && input.request.method === "DELETE") {
    return json(
      apiEnvelope(
        input.store.deleteQueuedMessage(
          decodeURIComponent(queuedMessageMatch[1]!),
        ),
      ),
    );
  }
  if (input.request.method === "POST" && url.pathname === "/messages") {
    const body = await parseJson(input.request);
    if (!isMessageSendRequest(body))
      throw new RequestError(
        400,
        "invalid_request",
        "Message text is required.",
      );
    const chatId = body.chat_id?.trim() || "general";
    if (!input.messageRateLimiter.consume(`messages:${chatId}`)) {
      throw new RequestError(
        429,
        "rate_limited",
        "Too many messages. Please wait before sending again.",
      );
    }
    return json(
      apiEnvelope(
        await input.store.sendMessage(body, input.responder, {
          responderTimeoutMs: input.responderTimeoutMs,
          deferResponderTurns: true,
        }),
      ),
      202,
    );
  }
  if (input.request.method === "GET" && url.pathname === "/session-summary") {
    const sessionId =
      url.searchParams.get("session_id") ?? url.searchParams.get("sessionId");
    if (!sessionId)
      throw new RequestError(
        400,
        "session_required",
        "Session id is required.",
      );
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope<SessionSummaryView>(input.store.getSessionSummary(sessionId)),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/session-view") {
    const sessionId =
      url.searchParams.get("session_id") ?? url.searchParams.get("sessionId");
    if (!sessionId)
      throw new RequestError(
        400,
        "session_required",
        "Session id is required.",
      );
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope<SessionView>(input.store.getSessionView(sessionId)),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/context-details") {
    const sessionId =
      url.searchParams.get("session_id") ?? url.searchParams.get("sessionId");
    if (!sessionId)
      throw new RequestError(
        400,
        "session_required",
        "Session id is required.",
      );
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope<ContextDetailsView>(input.store.getContextDetails(sessionId)),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/artifacts") {
    const sessionId =
      url.searchParams.get("session_id") ?? url.searchParams.get("sessionId");
    if (!sessionId)
      throw new RequestError(
        400,
        "session_required",
        "Session id is required.",
      );
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope({ artifacts: input.store.listArtifacts(sessionId) }),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/transcript-export") {
    const sessionId =
      url.searchParams.get("session_id") ?? url.searchParams.get("sessionId");
    if (!sessionId)
      throw new RequestError(
        400,
        "session_required",
        "Session id is required.",
      );
    return json(
      apiEnvelope<TranscriptExportView>(
        input.store.exportTranscript(sessionId),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/automations") {
    return json(
      apiEnvelope<AutomationListView>(
        input.store.listAutomations({
          targetSessionId:
            url.searchParams.get("target_session_id") ?? undefined,
        }),
      ),
    );
  }
  if (input.request.method === "POST" && url.pathname === "/automations") {
    const body = await parseJson(input.request);
    if (!isCreateAutomationRequest(body)) {
      throw new RequestError(
        400,
        "invalid_request",
        "Automation title, prompt, target, and interval are required.",
      );
    }
    return json(
      apiEnvelope<AutomationMutationResult>(input.store.createAutomation(body)),
      201,
    );
  }
  if (
    input.request.method === "POST" &&
    url.pathname === "/automations/dispatch-due"
  ) {
    return json(
      apiEnvelope(
        await input.store.dispatchDueAutomations(input.responder, {
          responderTimeoutMs: input.responderTimeoutMs,
        }),
      ),
      202,
    );
  }
  const automationMatch = url.pathname.match(/^\/automations\/([^/]+)$/u);
  if (input.request.method === "GET" && automationMatch) {
    return json(
      apiEnvelope<AutomationDetailView>(
        input.store.getAutomation(decodeURIComponent(automationMatch[1]!)),
      ),
    );
  }
  if (input.request.method === "PATCH" && automationMatch) {
    const body = await parseJson(input.request);
    return json(
      apiEnvelope<AutomationMutationResult>(
        input.store.updateAutomation(
          decodeURIComponent(automationMatch[1]!),
          body && typeof body === "object" ? body : {},
        ),
      ),
    );
  }
  if (input.request.method === "DELETE" && automationMatch) {
    return json(
      apiEnvelope<AutomationMutationResult>(
        input.store.deleteAutomation(decodeURIComponent(automationMatch[1]!)),
      ),
    );
  }
  const automationActionMatch =
    input.request.method === "POST"
      ? url.pathname.match(/^\/automations\/([^/]+)\/(run|pause|resume)$/u)
      : null;
  if (automationActionMatch) {
    const automationId = decodeURIComponent(automationActionMatch[1]!);
    const action = automationActionMatch[2];
    if (action === "run") {
      return json(
        apiEnvelope<AutomationRunResult>(
          await input.store.runAutomationNow(automationId, input.responder, {
            responderTimeoutMs: input.responderTimeoutMs,
          }),
        ),
        202,
      );
    }
    if (action === "pause") {
      return json(
        apiEnvelope<AutomationMutationResult>(
          input.store.pauseAutomation(automationId),
        ),
        202,
      );
    }
    return json(
      apiEnvelope<AutomationMutationResult>(
        input.store.resumeAutomation(automationId),
      ),
      202,
    );
  }
  const automationRunsMatch =
    input.request.method === "GET"
      ? url.pathname.match(/^\/automations\/([^/]+)\/runs$/u)
      : null;
  if (automationRunsMatch) {
    return json(
      apiEnvelope<AutomationRunListView>(
        input.store.listAutomationRuns(
          decodeURIComponent(automationRunsMatch[1]!),
        ),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/worker-activity") {
    return json(
      apiEnvelope<WorkerActivityListView>(
        input.store.listWorkerActivity({
          includeHistory: url.searchParams.get("include_history") === "true",
        }),
      ),
    );
  }
  const workerActivityMatch = url.pathname.match(
    /^\/worker-activity\/([^/]+)$/u,
  );
  if (input.request.method === "GET" && workerActivityMatch) {
    return json(
      apiEnvelope<WorkerActivitySummary>(
        input.store.getWorkerActivity(
          decodeURIComponent(workerActivityMatch[1]!),
        ),
      ),
    );
  }
  const workerControlMatch =
    input.request.method === "POST"
      ? url.pathname.match(/^\/worker-activity\/([^/]+)\/control$/u)
      : null;
  if (workerControlMatch) {
    const body = await parseJson(input.request);
    return json(
      apiEnvelope<WorkerActivityControlResult>(
        input.store.controlWorkerActivity(
          decodeURIComponent(workerControlMatch[1]!),
          (body && typeof body === "object"
            ? body
            : { action: "cancel" }) as WorkerActivityControlRequest,
        ),
      ),
      202,
    );
  }
  if (input.request.method === "GET" && url.pathname === "/events") {
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    const events = input.store.replayEvents(
      Number.isFinite(cursor) ? cursor : 0,
    );
    return json(
      apiEnvelope<EventReplayView>({
        events,
        next_cursor:
          events.at(-1)?.id ?? (Number.isFinite(cursor) ? cursor : 0),
      }),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/events/live") {
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    return liveEventsResponse(
      input.store,
      Number.isFinite(cursor) ? cursor : 0,
    );
  }
  if (input.request.method === "GET") {
    return await serveStatic(input.uiRoot, url.pathname);
  }
  return json(apiError("not_found", "Route not found."), 404);
}

function normalizeLocalAuth(
  input: CreateAppServerOptions["localAuth"],
): LocalAuthConfig {
  return {
    required: input?.required === true,
    token: safeString(input?.token) ?? null,
  };
}

function enforceLocalAuth(
  request: Request,
  localAuth: LocalAuthConfig,
): void {
  if (!localAuth.required) return;
  if (isStaticUiRequest(request)) return;
  if (!localAuth.token) {
    throw new RequestError(
      503,
      "local_auth_unconfigured",
      "Butler App local auth is not configured.",
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/iu.exec(header);
  if (!match || !constantTimeTokenEqual(match[1] ?? "", localAuth.token)) {
    throw new RequestError(
      401,
      "local_auth_required",
      "Butler App local auth is required.",
    );
  }
}

function isStaticUiRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const pathname = new URL(request.url).pathname;
  if (pathname === "/") return true;
  const extension = extname(pathname);
  return Boolean(extension && MIME_TYPES[extension]);
}

function constantTimeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new RequestError(400, "invalid_json", "Request body must be JSON.");
  }
}

async function serveStatic(root: string, pathname: string): Promise<Response> {
  const normalizedRoot = resolve(root);
  const relPath =
    pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = resolve(normalizedRoot, relPath);
  if (!isPathInsideRoot(normalizedRoot, filePath)) {
    return json(apiError("not_found", "Route not found."), 404);
  }
  if (!existsSync(filePath)) {
    const fallback = join(normalizedRoot, "index.html");
    if (!existsSync(fallback))
      return json(apiError("not_found", "Route not found."), 404);
    return new Response(await readFile(fallback), {
      headers: staticHeaders(MIME_TYPES[".html"]),
    });
  }
  const type = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
  return new Response(await readFile(filePath), {
    headers: staticHeaders(type),
  });
}

function isPathInsideRoot(root: string, filePath: string): boolean {
  const normalizedRoot = root.toLocaleLowerCase("en-US");
  const normalizedFilePath = filePath.toLocaleLowerCase("en-US");
  return (
    normalizedFilePath === normalizedRoot ||
    normalizedFilePath.startsWith(`${normalizedRoot}${sep}`)
  );
}

function staticHeaders(contentType: string): HeadersInit {
  return {
    "content-type": contentType,
    ...STATIC_SECURITY_HEADERS,
  };
}

function json(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function liveEventsResponse(store: AppServerStore, cursor: number): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const closeStream = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // The client may already have closed the stream.
        }
      };
      const writeText = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closeStream();
        }
      };
      const writeEvent = (event: AppEventEnvelope) =>
        writeText(formatSseEvent(event));
      unsubscribe = store.subscribeEvents((event) => {
        if (event.id > cursor) writeEvent(event);
      });
      for (const event of store.replayEvents(cursor)) writeEvent(event);
      if (!closed)
        heartbeat = setInterval(() => {
          try {
            store.syncAllAppTransportEvents();
            writeText(": heartbeat\n\n");
          } catch {
            closeStream();
          }
        }, 1_000);
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function formatSseEvent(event: AppEventEnvelope): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function maxCursor(
  values: Array<number | undefined>,
  fallback: number,
): number {
  return values.reduce<number>((max, value) => {
    const cursor = Number(value ?? 0);
    return Number.isFinite(cursor) && cursor > max ? cursor : max;
  }, fallback);
}

function normalizeLocalHttpOrigin(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    const isLocalhost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1";
    if (url.protocol !== "http:" || !isLocalhost) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeDevCorsPolicy(value?: string): DevCorsPolicy {
  const configuredOrigins = String(value ?? "")
    .split(",")
    .map((origin) => normalizeLocalHttpOrigin(origin.trim()))
    .filter((origin): origin is string => Boolean(origin));
  if (configuredOrigins.length > 0) {
    return { origins: new Set(configuredOrigins), allowLocalLoopback: false };
  }
  return {
    origins: new Set([DEFAULT_DEV_CORS_ORIGIN]),
    allowLocalLoopback: true,
  };
}

function devCorsHeaders(
  request: Request,
  devCorsPolicy: DevCorsPolicy,
): Record<string, string> {
  const origin = request.headers.get("origin");
  const normalizedOrigin = normalizeLocalHttpOrigin(origin ?? undefined);
  if (!normalizedOrigin) return {};
  const allowed =
    devCorsPolicy.origins.has(normalizedOrigin) ||
    devCorsPolicy.allowLocalLoopback;
  if (!allowed) return {};
  return {
    "access-control-allow-origin": normalizedOrigin,
    vary: "Origin",
  };
}

function withExtraHeaders(
  response: Response,
  extraHeaders: HeadersInit,
): Response {
  const extra = new Headers(extraHeaders);
  if ([...extra.keys()].length === 0) return response;
  const headers = new Headers(response.headers);
  extra.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isUploadFile(value: FormDataEntryValue | null): value is File {
  return Boolean(
    value &&
    typeof value === "object" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function" &&
    "name" in value &&
    typeof value.name === "string",
  );
}

function safeOptionalString(
  value: FormDataEntryValue | null,
): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function contentDispositionForAttachment(name: string): string {
  const fallback = asciiAttachmentFilenameFallback(name);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(name)}`;
}

function asciiAttachmentFilenameFallback(value: string): string {
  const fallback = Array.from(value || "attachment", (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint > 0x7e) return "_";
    if (character === "\"" || character === "\\") return "_";
    return character;
  })
    .join("")
    .replace(/_+/gu, "_")
    .replace(/[\r\n]+/gu, "_")
    .trim()
    .slice(0, 160);
  return fallback && /[A-Za-z0-9]/u.test(fallback) ? fallback : "attachment";
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value)
    .replace(
      /['()]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/\*/gu, "%2A");
}

function paginationFromSearchParams(
  searchParams: URLSearchParams,
): { limit?: number; offset?: number } {
  return {
    limit: parsePositiveInteger(searchParams.get("limit")),
    offset: parseNonNegativeInteger(searchParams.get("offset")),
  };
}

function usageMonitorFromSearchParams(
  searchParams: URLSearchParams,
): { sessionId?: string; sinceTs?: number | null } {
  const sinceHours = parsePositiveNumber(
    searchParams.get("since_hours") ?? searchParams.get("sinceHours"),
  );
  const sessionId =
    searchParams.get("session_id") ?? searchParams.get("sessionId") ?? "";
  return {
    sessionId: sessionId.trim() || undefined,
    sinceTs: sinceHours === undefined
      ? null
      : Date.now() - sinceHours * 60 * 60 * 1000,
  };
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

function parsePositiveNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class FixedWindowRateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<
    string,
    { count: number; resetAt: number }
  >();

  constructor(options: MessageRateLimitOptions = {}) {
    const max = Number(options.max ?? DEFAULT_MESSAGE_RATE_LIMIT.max);
    const windowMs = Number(
      options.windowMs ?? DEFAULT_MESSAGE_RATE_LIMIT.windowMs,
    );
    this.max =
      Number.isFinite(max) && max > 0 ? max : DEFAULT_MESSAGE_RATE_LIMIT.max;
    this.windowMs =
      Number.isFinite(windowMs) && windowMs > 0
        ? windowMs
        : DEFAULT_MESSAGE_RATE_LIMIT.windowMs;
  }

  consume(key: string): boolean {
    const now = Date.now();
    this.pruneExpired(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.max) return false;
    bucket.count += 1;
    return true;
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
