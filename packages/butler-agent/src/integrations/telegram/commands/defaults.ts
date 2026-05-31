// Default numeric constants for Telegram command flows. All values are
// overridable via butler.config.json (telegram.topic.* / telegram.autoRegister.*
// / telegram.undoWindowSec). No handler should hardcode these numbers.

export const TOPIC_DEFAULTS = {
  undoWindowSec: 30,
  sessionTtlSec: 300,
  awaitInputTtlSec: 60,
  pageSize: 10,
  ackReaction: "⚡",
} as const;

export const AUTOREGISTER_DEFAULTS = {
  rateLimitPerMinute: 5,
  burst: 10,
  windowSec: 60,
} as const;

export type TopicConfig = {
  undoWindowSec: number
  sessionTtlSec: number
  awaitInputTtlSec: number
  pageSize: number
  ackReaction: string
};

export type AutoRegisterConfig = {
  rateLimitPerMinute: number
  burst: number
  windowSec: number
};

export function resolveTopicConfig(raw: Partial<TopicConfig> | undefined | null): TopicConfig {
  return {
    undoWindowSec: raw?.undoWindowSec ?? TOPIC_DEFAULTS.undoWindowSec,
    sessionTtlSec: raw?.sessionTtlSec ?? TOPIC_DEFAULTS.sessionTtlSec,
    awaitInputTtlSec: raw?.awaitInputTtlSec ?? TOPIC_DEFAULTS.awaitInputTtlSec,
    pageSize: raw?.pageSize ?? TOPIC_DEFAULTS.pageSize,
    ackReaction: raw?.ackReaction ?? TOPIC_DEFAULTS.ackReaction,
  };
}

export function resolveAutoRegisterConfig(
  raw: Partial<AutoRegisterConfig> | undefined | null,
): AutoRegisterConfig {
  return {
    rateLimitPerMinute: raw?.rateLimitPerMinute ?? AUTOREGISTER_DEFAULTS.rateLimitPerMinute,
    burst: raw?.burst ?? AUTOREGISTER_DEFAULTS.burst,
    windowSec: raw?.windowSec ?? AUTOREGISTER_DEFAULTS.windowSec,
  };
}
