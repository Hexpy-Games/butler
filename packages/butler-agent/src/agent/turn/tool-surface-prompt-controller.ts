import type { FunctionToolDefinition } from "../../integrations/providers/provider.ts";
import {
  selectInitialToolsFromSurfaceController,
  type InitialToolSurfaceSelectionInput,
} from "../tools/tool-surface-selection.ts";

export interface ToolSurfacePromptControllerInput {
  role: string;
  message?: string;
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
  providerCapabilities?: InitialToolSurfaceSelectionInput["providerCapabilities"];
  tools: readonly FunctionToolDefinition[];
  providerSupportsSchemaPromotion: boolean;
}

export interface SelectedToolSurfacePromptState {
  tools: FunctionToolDefinition[];
  dynamicTools?: () => readonly FunctionToolDefinition[];
}

export class ToolSurfacePromptController {
  readonly describedToolIds = new Set<string>();
  readonly promotedNativeToolNames = new Set<string>();

  private currentProviderTools: readonly FunctionToolDefinition[] = [];

  constructor(private readonly input: ToolSurfacePromptControllerInput) {}

  currentToolNames(): readonly string[] {
    return this.currentDynamicProviderTools().map((tool) => tool.name);
  }

  describedToolIdList(): string[] {
    return [...this.describedToolIds];
  }

  initialToolNames(): string[] {
    return this.selectInitialSurface().toolNames;
  }

  async runWithSelectedSurface<T>(
    run: (state: SelectedToolSurfacePromptState) => Promise<T>,
  ): Promise<T> {
    const selectedSurface = this.selectInitialSurface();
    const previousProviderTools = this.currentProviderTools;
    this.currentProviderTools = selectedSurface.tools;
    try {
      return await run({
        tools: selectedSurface.tools,
        dynamicTools: this.input.providerSupportsSchemaPromotion
          ? () => this.currentDynamicProviderTools()
          : undefined,
      });
    } finally {
      this.currentProviderTools = previousProviderTools;
    }
  }

  recordToolDescriptionResult(result: unknown): void {
    recordDescribedToolIds(this.describedToolIds, result);
    recordPromotedNativeToolNames(this.promotedNativeToolNames, result);
  }

  private selectInitialSurface() {
    return selectInitialToolsFromSurfaceController({
      role: this.input.role,
      message: this.input.message,
      sessionMetadata: this.input.sessionMetadata,
      turnMetadata: this.input.turnMetadata,
      providerCapabilities: this.input.providerCapabilities,
      tools: this.input.tools,
    });
  }

  private currentDynamicProviderTools(): FunctionToolDefinition[] {
    if (!this.input.providerSupportsSchemaPromotion) {
      return [...this.currentProviderTools];
    }
    return mergeFunctionToolDefinitions(
      this.currentProviderTools,
      promotedNativeToolDefinitions(this.input.tools, this.promotedNativeToolNames),
    );
  }
}

function recordDescribedToolIds(target: Set<string>, result: unknown): void {
  if (!isRecord(result) || !Array.isArray(result.descriptions)) return;
  for (const item of result.descriptions) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const id = item.id.trim();
    if (id) target.add(id);
  }
}

function recordPromotedNativeToolNames(target: Set<string>, result: unknown): void {
  if (!isRecord(result) || !Array.isArray(result.descriptions)) return;
  for (const item of result.descriptions) {
    if (!isRecord(item)) continue;
    const affordance = isRecord(item.call_affordance) ? item.call_affordance : {};
    const toolName = typeof affordance.tool_name === "string" ? affordance.tool_name.trim() : "";
    if (affordance.type === "native_tool" && toolName) target.add(toolName);
  }
}

function promotedNativeToolDefinitions(
  tools: readonly FunctionToolDefinition[],
  toolNames: ReadonlySet<string>,
): FunctionToolDefinition[] {
  if (toolNames.size === 0) return [];
  return tools.filter((tool) => toolNames.has(tool.name));
}

function mergeFunctionToolDefinitions(
  baseTools: readonly FunctionToolDefinition[],
  extraTools: readonly FunctionToolDefinition[],
): FunctionToolDefinition[] {
  const merged = new Map<string, FunctionToolDefinition>();
  for (const tool of baseTools) merged.set(tool.name, tool);
  for (const tool of extraTools) merged.set(tool.name, tool);
  return [...merged.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
