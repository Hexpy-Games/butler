import {
  apiEnvelope,
  isHostedModelRegistrationRequest,
  isLocalModelDiscoveryRequest,
  isLocalModelRegistrationRequest,
  isLocalModelUpdateRequest,
  isMcpServerUpsertRequest,
  isProviderCredentialUpsertRequest,
  isUpdateSettingsRequest,
  type CommandPaletteView,
  type HostedModelDeletionResult,
  type HostedModelRegistrationResult,
  type LocalModelDeletionResult,
  type LocalModelDiscoveryResult,
  type LocalModelRegistrationResult,
  type McpCapabilitiesView,
  type McpServerDeleteResult,
  type McpServerListView,
  type McpServerMutationResult,
  type ModelCatalogView,
  type ProviderCredentialMutationResult,
  type SettingsView,
  type SkillImportResult,
  type SkillSettingsView,
} from "../../protocol/app-protocol.ts";
import { isUploadFile, safeOptionalString } from "../form-data.ts";
import { json, parseJson, RequestError } from "../responses.ts";

import type { AppRouteContext } from "../server-types.ts";

export async function handleSettingsRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  const { url } = input;
  if (input.request.method === "GET" && url.pathname === "/settings") {
    return json(apiEnvelope<SettingsView>(input.store.getSettings()));
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
  if (input.request.method === "GET" && url.pathname === "/command-palette") {
    return json(
      apiEnvelope<CommandPaletteView>(
        input.store.searchCommandPalette(url.searchParams.get("query") ?? ""),
      ),
    );
  }
  return null;
}
