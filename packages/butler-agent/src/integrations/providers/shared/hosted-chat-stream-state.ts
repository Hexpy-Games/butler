type ToolCallAccumulator = {
  index: number;
  id: string;
  type: "function";
  name: string;
  arguments: string;
};

export type HostedChatAccumulator = {
  id: string;
  model: string;
  role: string;
  content: string;
  toolCalls: Map<number, ToolCallAccumulator>;
  finishReason: unknown;
  usage?: Record<string, unknown>;
};

export class HostedChatStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedChatStreamProtocolError";
  }
}

/** A provider can send a structured failure after accepting an SSE stream. */
export class HostedChatStreamProviderError extends Error {
  readonly statusCode?: number;

  constructor(readonly providerError: unknown) {
    super("Hosted Chat Completions returned a structured provider error");
    this.name = "HostedChatStreamProviderError";
    const record = isRecord(providerError) ? providerError : {};
    this.statusCode = typeof record.status === "number"
      ? record.status
      : typeof record.code === "number"
        ? record.code
        : undefined;
  }
}

export function parseProviderEvent(data: string): Record<string, any> {
  try {
    const value = JSON.parse(data);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HostedChatStreamProtocolError(
      "Hosted Chat Completions returned a malformed SSE event",
    );
  }
}

export function createAccumulator(): HostedChatAccumulator {
  return {
    id: "",
    model: "",
    role: "assistant",
    content: "",
    toolCalls: new Map(),
    finishReason: null,
  };
}

export function accumulateProviderEvent(
  state: HostedChatAccumulator,
  event: Record<string, any>,
): void {
  const providerError = isRecord(event.error)
    ? event.error
    : isRecord(event.response?.error)
      ? event.response.error
      : event.type === "error"
        ? event
        : undefined;
  if (providerError) throw new HostedChatStreamProviderError(providerError);
  if (typeof event.id === "string") state.id = event.id;
  if (typeof event.model === "string") state.model = event.model;
  if (isRecord(event.usage)) state.usage = event.usage;
  const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
  if (!isRecord(choice)) return;
  if (choice.finish_reason !== undefined) state.finishReason = choice.finish_reason;
  const delta = isRecord(choice.delta) ? choice.delta : {};
  if (typeof delta.role === "string") state.role = delta.role;
  if (typeof delta.content === "string") state.content += delta.content;
  if (Array.isArray(delta.tool_calls)) {
    for (const toolCall of delta.tool_calls) accumulateToolCall(state, toolCall);
  }
}

function accumulateToolCall(state: HostedChatAccumulator, delta: unknown): void {
  if (!isRecord(delta) || !Number.isInteger(delta.index)) return;
  const index = Number(delta.index);
  const current = state.toolCalls.get(index) ?? {
    index,
    id: "",
    type: "function" as const,
    name: "",
    arguments: "",
  };
  if (typeof delta.id === "string") current.id += delta.id;
  const fn = isRecord(delta.function) ? delta.function : {};
  if (typeof fn.name === "string") current.name += fn.name;
  if (typeof fn.arguments === "string") current.arguments += fn.arguments;
  state.toolCalls.set(index, current);
}

export function completedResponse(state: HostedChatAccumulator): Record<string, any> {
  const toolCalls = [...state.toolCalls.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ id, type, name, arguments: args }) => ({
      id,
      type,
      function: { name, arguments: args },
    }));
  return {
    id: state.id,
    model: state.model,
    choices: [{
      index: 0,
      finish_reason: state.finishReason,
      message: {
        role: state.role,
        content: state.content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    }],
    ...(state.usage ? { usage: state.usage } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
