import type { WebSearchProvider } from "../../../../integrations/search/provider.ts";
import { BUTLER_TOOLS, TOOL_CAPABILITY_METADATA } from "../../registry.ts";
import { buildExternalToolCatalog, buildNativeToolCatalog, type ExternalToolCatalogInput } from "../../progressive-catalog.ts";
import { buildMcpToolCatalog } from "../../progressive-mcp-catalog.ts";
import { searchToolCatalog } from "../../progressive-search.ts";
import { nativeToolAvailability } from "../../tool-availability.ts";
import type { ToolCapabilityCategory, ToolCatalogProvider } from "../../types.ts";

type ToolCall = { args: Record<string, unknown> };

export function createToolSearchToolHandler(input: {
  butlerData: string;
  webSearchProvider?: WebSearchProvider;
  mcpTimeoutMs?: number;
  pluginCatalog?: readonly ExternalToolCatalogInput[] | (() => Promise<readonly ExternalToolCatalogInput[]>);
}) {
  return async (call: ToolCall) => {
    const category = parseCategory(call.args.category);
    const provider = parseProvider(call.args.provider);
    if (category.invalid || provider.invalid) {
      return {
        ok: false,
        error: {
          code: category.invalid ? "invalid_tool_category" : "invalid_tool_provider",
          message: category.invalid
            ? `Unknown tool capability category: ${category.invalid}`
            : `Unknown tool provider: ${provider.invalid}`,
        },
        invalid_category: category.invalid ?? null,
        invalid_provider: provider.invalid ?? null,
        results: [],
      };
    }

    const catalog = [
      ...buildNativeToolCatalog({
        tools: BUTLER_TOOLS,
        metadata: TOOL_CAPABILITY_METADATA,
        resolveAvailability: (tool) => nativeToolAvailability(tool, input),
      }),
      ...await maybeBuildMcpToolCatalog({
        input,
        provider: provider.value,
        category: category.value,
        includeDisabled: call.args.include_disabled === true,
      }),
      ...buildExternalToolCatalog(await resolvePluginCatalog(input.pluginCatalog)),
    ];
    return {
      ok: true,
      results: searchToolCatalog({
        catalog,
        query: stringArg(call.args.query),
        capability: stringArg(call.args.capability),
        category: category.value,
        provider: provider.value,
        includeDisabled: call.args.include_disabled !== false,
        limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
      }),
    };
  };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCategory(value: unknown): { value?: ToolCapabilityCategory; invalid?: string } {
  const normalized = stringArg(value);
  if (!normalized) return {};
  const lower = normalized.toLowerCase();
  if (VALID_CATEGORIES.includes(lower as ToolCapabilityCategory)) {
    return { value: lower as ToolCapabilityCategory };
  }
  return { invalid: normalized };
}

function parseProvider(value: unknown): { value?: ToolCatalogProvider; invalid?: string } {
  const normalized = stringArg(value);
  if (!normalized) return {};
  const lower = normalized.toLowerCase();
  if (VALID_PROVIDERS.includes(lower as ToolCatalogProvider)) {
    return { value: lower as ToolCatalogProvider };
  }
  return { invalid: normalized };
}

async function resolvePluginCatalog(
  value: readonly ExternalToolCatalogInput[] | (() => Promise<readonly ExternalToolCatalogInput[]>) | undefined,
): Promise<readonly ExternalToolCatalogInput[]> {
  if (!value) return [];
  return typeof value === "function" ? await value() : value;
}

async function maybeBuildMcpToolCatalog(input: {
  input: {
    butlerData: string;
    mcpTimeoutMs?: number;
  };
  provider?: ToolCatalogProvider;
  category?: ToolCapabilityCategory;
  includeDisabled: boolean;
}) {
  if (input.provider && input.provider !== "mcp") return [];
  if (!input.provider && input.category !== "mcp") return [];
  return await buildMcpToolCatalog({
    butlerData: input.input.butlerData,
    includeDisabled: input.includeDisabled,
    timeoutMs: input.input.mcpTimeoutMs,
  });
}

const VALID_CATEGORIES = [
  "search",
  "data",
  "command",
  "file",
  "work",
  "monitoring",
  "automation",
  "todo",
  "memory",
  "project",
  "skill",
  "mcp",
  "dispatch",
  "control",
] as const satisfies readonly ToolCapabilityCategory[];

const VALID_PROVIDERS = [
  "native",
  "mcp",
  "plugin",
] as const satisfies readonly ToolCatalogProvider[];
