import type { RecallChannel } from "./contracts.ts";

export type EpisodeRankInput = {
  episodeId: string;
  conversationAt: string | null;
  eventAt?: string | null;
  sessionId: string;
  graphRank?: number;
  lexicalRank?: number;
  vectorRank?: number;
  contextRank?: number;
  explicitPriority?: boolean;
  salience?: "high" | "normal" | "unspecified";
  supportCount?: number;
  halfLifeDays?: number;
};

export type ExecutedEpisodeChannels = {
  graph: boolean;
  vector: boolean;
  lexical: boolean;
  context: boolean;
};

export type RankedEpisode = EpisodeRankInput & { score: number; channels: RecallChannel[] };

const RRF_K = 60;
const CHANNEL_WEIGHTS = { graph: 1, vector: 1, lexical: 0.5, context: 0.5 } as const;

export function fuseEpisodeCandidates(channelLists: {
  graph: string[];
  vector: string[];
  lexical: string[];
  context: string[];
}): { episodeIds: string[]; candidateLimit: boolean } {
  const queues = [channelLists.graph, channelLists.vector, channelLists.lexical, channelLists.context].map((items) => items.slice(0, 128));
  const offsets = [0, 0, 0, 0];
  const seen = new Set<string>();
  const episodeIds: string[] = [];
  while (episodeIds.length < 128 && queues.some((queue, index) => offsets[index]! < queue.length)) {
    for (let index = 0; index < queues.length && episodeIds.length < 128; index += 1) {
      const value = queues[index]![offsets[index]!] as string | undefined;
      offsets[index] = offsets[index]! + 1;
      if (value !== undefined && !seen.has(value)) { seen.add(value); episodeIds.push(value); }
    }
  }
  return { episodeIds, candidateLimit: queues.some((queue, index) => offsets[index]! < queue.length) };
}

export function rankEpisodes(
  values: EpisodeRankInput[],
  executed: ExecutedEpisodeChannels,
  asOf: string,
  timeBasis: "conversation" | "event" = "conversation",
): RankedEpisode[] {
  const denominator = (Object.entries(CHANNEL_WEIGHTS) as Array<[keyof ExecutedEpisodeChannels, number]>)
    .reduce((sum, [channel, weight]) => sum + (executed[channel] ? weight / 61 : 0), 0) || 1;
  const asOfMs = Date.parse(asOf);
  return values.map((value) => {
    const channels: RecallChannel[] = [];
    if (value.graphRank !== undefined) channels.push("graph");
    if (value.vectorRank !== undefined) channels.push("vector");
    if (value.lexicalRank !== undefined) channels.push("lexical");
    if (value.contextRank !== undefined) channels.push("context");
    const fused = (
      CHANNEL_WEIGHTS.graph * rrf(value.graphRank) +
      CHANNEL_WEIGHTS.vector * rrf(value.vectorRank) +
      CHANNEL_WEIGHTS.lexical * rrf(value.lexicalRank) +
      CHANNEL_WEIGHTS.context * rrf(value.contextRank)
    ) / denominator;
    const salience = value.salience === "high" ? 1 : value.salience === "normal" ? 0.5 : 0;
    const basisAt = timeBasis === "event" ? value.eventAt : value.conversationAt;
    const ageDays = basisAt ? Math.max(0, (asOfMs - Date.parse(basisAt)) / 86_400_000) : Number.POSITIVE_INFINITY;
    const recency = Number.isFinite(ageDays) ? 2 ** (-ageDays / (value.halfLifeDays ?? 30)) : 0;
    const support = Math.min(1, Math.log1p(value.supportCount ?? 0) / Math.log(17));
    return { ...value, score: 0.8 * fused + 0.1 * salience + 0.06 * recency + 0.04 * support, channels };
  }).sort((a, b) => Number(b.explicitPriority) - Number(a.explicitPriority) || b.score - a.score ||
    compareNullableTime(timeBasis === "event" ? b.eventAt ?? null : b.conversationAt, timeBasis === "event" ? a.eventAt ?? null : a.conversationAt) ||
    Buffer.compare(Buffer.from(a.episodeId), Buffer.from(b.episodeId)));
}

export function diversifyBySession(values: RankedEpisode[], limit: number): RankedEpisode[] {
  const selected: RankedEpisode[] = [];
  const sessions = new Set<string>();
  for (const value of values) {
    if (!sessions.has(value.sessionId)) { selected.push(value); sessions.add(value.sessionId); }
    if (selected.length >= limit) return selected;
  }
  const selectedIds = new Set(selected.map((value) => value.episodeId));
  for (const value of values) {
    if (!selectedIds.has(value.episodeId)) selected.push(value);
    if (selected.length >= limit) break;
  }
  return selected;
}

function rrf(rank: number | undefined): number { return rank === undefined ? 0 : 1 / (RRF_K + rank); }
function compareNullableTime(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
