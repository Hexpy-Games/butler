export interface JsonEnvelopeError {
  code: string;
  message: string;
}

export interface JsonEnvelopePrivacy {
  rawTextIncluded: boolean;
  secretsIncluded: boolean;
}

export interface JsonEnvelopeInput {
  ok: boolean;
  command: string;
  data?: unknown;
  error?: JsonEnvelopeError | null;
  privacy?: Partial<JsonEnvelopePrivacy>;
}

export interface JsonEnvelope {
  ok: boolean;
  command: string;
  data: unknown;
  error: JsonEnvelopeError | null;
  privacy: JsonEnvelopePrivacy;
}

const safePrivacyDefaults: JsonEnvelopePrivacy = {
  rawTextIncluded: false,
  secretsIncluded: false,
};

export function createJsonEnvelope(input: JsonEnvelopeInput): JsonEnvelope {
  return {
    ok: input.ok,
    command: input.command,
    data: input.ok ? (input.data ?? null) : null,
    error: input.error ?? null,
    privacy: {
      ...safePrivacyDefaults,
      ...input.privacy,
    },
  };
}

export function renderJsonEnvelope(input: JsonEnvelopeInput): string {
  return `${JSON.stringify(createJsonEnvelope(input), null, 2)}\n`;
}
