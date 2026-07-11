import type { FunctionToolDefinition } from "../../../../integrations/providers/provider.ts";

export function requireExplicitPlanUpdate(
  tool: FunctionToolDefinition,
): FunctionToolDefinition {
  if (tool.name !== "update_todo_list") return tool;
  const parameters = recordValue(tool.parameters);
  const properties = recordValue(parameters.properties);
  const todos = recordValue(properties.todos);
  const items = recordValue(todos.items);
  const required = Array.isArray(items.required)
    ? items.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...tool,
    description: [
      tool.description,
      "The active execution contract requires an explicit bound plan before ordinary tools are exposed.",
      "Create at least one stable-id, phased, non-reporting work item and keep at most one item in_progress.",
    ].join(" "),
    parameters: {
      ...parameters,
      properties: {
        ...properties,
        todos: {
          ...todos,
          minItems: 1,
          items: {
            ...items,
            required: [...new Set([...required, "id", "phase"])],
          },
        },
      },
    },
  };
}

export function explicitPlanArguments(args: Record<string, unknown>): boolean {
  if (!Array.isArray(args.todos) || args.todos.length === 0) return false;
  return args.todos.some((value) => {
    const item = recordValue(value);
    return typeof item.id === "string" && item.id.trim().length > 0 &&
      typeof item.phase === "string" && item.phase !== "reporting";
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
