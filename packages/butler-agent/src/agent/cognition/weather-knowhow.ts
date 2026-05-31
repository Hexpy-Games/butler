import { randomUUID } from "crypto";
import {
  existsSync,
  readFileSync,
} from "fs";
import {
  addFeedbackEntry,
  listFeedbackEntries,
  writeFeedbackEntries,
  type FeedbackEntry,
} from "./feedback/buffer.ts";
import {
  createBoxItem,
  listBoxManifests,
} from "./box/store.ts";
import {
  listKnowHowEntries,
  recordSourceQualityEvent,
  sourceQualityPath,
  writeKnowHowEntry,
  type KnowHowEntry,
} from "./know-how/store.ts";

export type WeatherSourceId = "open-meteo" | "nws";
export {
  addFeedbackEntry,
  listFeedbackEntries,
  writeFeedbackEntries,
  type FeedbackEntry,
} from "./feedback/buffer.ts";
export {
  listKnowHowEntries,
  readKnowHowEntry,
  writeKnowHowEntry,
  type KnowHowEntry,
} from "./know-how/store.ts";

export type WeatherFetchSnapshot = {
  sourceId: WeatherSourceId;
  sourceUri: string;
  sourceTimestamp: string;
  fetchedAt: string;
  summary: string;
  raw: unknown;
};

export type WeatherKnowHowResult = {
  location: {
    name: string;
    latitude: number;
    longitude: number;
  };
  source: WeatherSourceId;
  sourceUri: string;
  sourceTimestamp: string;
  fetchedAt: string;
  freshnessAgeMinutes: number;
  fresh: boolean;
  summary: string;
  boxItemId: string;
  knowhowId: string;
  usedKnowHow: boolean;
  retrievedKnowHowBeforeGenericRouting: boolean;
  genericRoutingUsed: boolean;
  suppressedSources: WeatherSourceId[];
};

export type WeatherKnowHowInput = {
  butlerData: string;
  latitude: number;
  longitude: number;
  locationName?: string;
  now?: Date;
  fetcher?: typeof fetch;
};

type WeatherSourceAttempt = {
  sourceId: WeatherSourceId;
  uri: string;
};

function iso(date: Date = new Date()): string {
  return date.toISOString();
}

export function recordWeatherFeedback(
  butlerData: string,
  input: {
    sourceId?: WeatherSourceId;
    knowhowId?: string;
    text: string;
    now?: Date;
  },
): FeedbackEntry {
  const targetRef = input.knowhowId
    ? `knowhow:${input.knowhowId}`
    : `source:${input.sourceId ?? "open-meteo"}`;
  return addFeedbackEntry(butlerData, {
    text: input.text,
    targetRef,
    category: "quality_signal",
    scope: input.knowhowId ? "knowhow" : "source",
    promotionTarget: input.knowhowId ? "knowhow" : "source_quality",
    priority: "high",
    now: input.now,
  });
}

function weatherKnowHow(entries: KnowHowEntry[]): KnowHowEntry | null {
  return entries.find((entry) =>
    entry.name === "weather_source_lookup" &&
    entry.status !== "disabled" &&
    entry.status !== "forgotten",
  ) ?? null;
}

function activeFeedback(entries: FeedbackEntry[]): FeedbackEntry[] {
  return entries.filter((entry) => entry.status === "active");
}

function suppressedSources(entries: FeedbackEntry[]): Set<WeatherSourceId> {
  const suppressed = new Set<WeatherSourceId>();
  for (const entry of activeFeedback(entries)) {
    if (entry.target_ref === "source:open-meteo") suppressed.add("open-meteo");
    if (entry.target_ref === "source:nws") suppressed.add("nws");
  }
  return suppressed;
}

function isUsCoordinate(latitude: number, longitude: number): boolean {
  return latitude >= 24 && latitude <= 50 && longitude >= -125 && longitude <= -66;
}

function openMeteoUri(latitude: number, longitude: number): string {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "precipitation",
      "weather_code",
      "wind_speed_10m",
    ].join(","),
    timezone: "auto",
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

function nwsPointUri(latitude: number, longitude: number): string {
  return `https://api.weather.gov/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

function chooseSources(
  input: WeatherKnowHowInput,
  knowhow: KnowHowEntry | null,
  disabled: Set<WeatherSourceId>,
): WeatherSourceAttempt[] {
  const matrix: WeatherSourceId[] = isUsCoordinate(input.latitude, input.longitude)
    ? ["nws", "open-meteo"]
    : ["open-meteo"];
  const preferred = (knowhow?.strategy.preferred_sources ?? []).filter(isWeatherSourceId);
  const ordered = [...preferred, ...matrix].filter((value, index, array) => array.indexOf(value) === index);
  return ordered
    .filter((sourceId) => !disabled.has(sourceId))
    .map((sourceId) => ({
      sourceId,
      uri: sourceId === "open-meteo"
        ? openMeteoUri(input.latitude, input.longitude)
        : nwsPointUri(input.latitude, input.longitude),
    }));
}

function isWeatherSourceId(value: string): value is WeatherSourceId {
  return value === "open-meteo" || value === "nws";
}

async function fetchJson(fetcher: typeof fetch, uri: string, headers: HeadersInit = {}): Promise<unknown> {
  const response = await fetcher(uri, { headers });
  if (!response.ok) throw new Error(`fetch failed ${response.status}: ${uri}`);
  return await response.json();
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseOpenMeteo(uri: string, raw: any, fetchedAt: string): WeatherFetchSnapshot {
  const current = raw?.current ?? {};
  const units = raw?.current_units ?? {};
  const temperature = numberValue(current.temperature_2m);
  const apparent = numberValue(current.apparent_temperature);
  const wind = numberValue(current.wind_speed_10m);
  const sourceTimestamp = typeof current.time === "string" ? current.time : fetchedAt;
  const summary = [
    temperature !== null ? `temperature=${temperature}${units.temperature_2m ?? ""}` : null,
    apparent !== null ? `apparent=${apparent}${units.apparent_temperature ?? ""}` : null,
    wind !== null ? `wind=${wind}${units.wind_speed_10m ?? ""}` : null,
  ].filter(Boolean).join(" ");
  return {
    sourceId: "open-meteo",
    sourceUri: uri,
    sourceTimestamp,
    fetchedAt,
    summary: summary || "Open-Meteo weather data fetched.",
    raw,
  };
}

async function fetchNws(fetcher: typeof fetch, uri: string, fetchedAt: string): Promise<WeatherFetchSnapshot> {
  const headers = {
    "User-Agent": "butler-weather-knowhow",
    Accept: "application/geo+json",
  };
  const point = await fetchJson(fetcher, uri, headers) as any;
  const forecastHourly = point?.properties?.forecastHourly;
  if (typeof forecastHourly !== "string") throw new Error("NWS point response missing forecastHourly");
  const forecast = await fetchJson(fetcher, forecastHourly, headers) as any;
  const period = forecast?.properties?.periods?.[0] ?? {};
  const sourceTimestamp = typeof period.startTime === "string"
    ? period.startTime
    : typeof forecast?.properties?.generatedAt === "string"
      ? forecast.properties.generatedAt
      : fetchedAt;
  const summary = [
    typeof period.temperature === "number" ? `temperature=${period.temperature}${period.temperatureUnit ?? ""}` : null,
    typeof period.shortForecast === "string" ? period.shortForecast : null,
    typeof period.windSpeed === "string" ? `wind=${period.windSpeed}` : null,
  ].filter(Boolean).join(" ");
  return {
    sourceId: "nws",
    sourceUri: forecastHourly,
    sourceTimestamp,
    fetchedAt,
    summary: summary || "NWS weather data fetched.",
    raw: forecast,
  };
}

async function fetchWeatherSource(
  attempt: WeatherSourceAttempt,
  input: WeatherKnowHowInput,
  fetchedAt: string,
): Promise<{ snapshot: WeatherFetchSnapshot; latencyMs: number }> {
  const fetcher = input.fetcher ?? fetch;
  const start = Date.now();
  const snapshot = attempt.sourceId === "open-meteo"
    ? parseOpenMeteo(attempt.uri, await fetchJson(fetcher, attempt.uri), fetchedAt)
    : await fetchNws(fetcher, attempt.uri, fetchedAt);
  return { snapshot, latencyMs: Date.now() - start };
}

function ageMinutes(timestamp: string, now: Date): number {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((now.getTime() - parsed.getTime()) / 60000));
}

function createBoxSnapshot(
  butlerData: string,
  snapshot: WeatherFetchSnapshot,
  input: WeatherKnowHowInput,
  now: string,
): string {
  const manifest = createBoxItem(butlerData, {
    kind: "source_snapshot",
    status: "indexed",
    capturedAt: snapshot.fetchedAt,
    title: `Weather source snapshot: ${input.locationName ?? `${input.latitude},${input.longitude}`}`,
    summary: snapshot.summary,
    tags: ["weather", snapshot.sourceId],
    origin: {
      producer: "weather-knowhow",
      session_id: null,
      turn_id: null,
      message_id: null,
      tool_call_id: null,
      worker_run_id: null,
      consolidation_run_id: null,
    },
    source: {
      uri: snapshot.sourceUri,
      local_path: null,
      provider: snapshot.sourceId,
      fetched_at: snapshot.fetchedAt,
      observed_at: snapshot.sourceTimestamp,
    },
    content: [{
      role: "primary",
      filename: "snapshot.json",
      data: JSON.stringify(snapshot.raw),
      mimeType: "application/json",
    }],
    privacy: {
      class: "public",
      external_provider_allowed: true,
      reason: "public-weather-source",
    },
    retention: {
      class: "working",
      pinned: false,
      expires_at: null,
    },
    freshness: {
      class: "current",
      source_timestamp: snapshot.sourceTimestamp,
      checked_at: now,
      expires_at: null,
    },
    citations: [snapshot.sourceUri],
    now: new Date(now),
  });
  return manifest.box_item_id;
}

function sourceQualityScore(freshnessAgeMinutes: number, maxAgeMinutes: number): number {
  if (!Number.isFinite(freshnessAgeMinutes)) return 0;
  return Math.max(0, Math.min(1, 1 - freshnessAgeMinutes / Math.max(maxAgeMinutes, 1)));
}

function createWeatherKnowHow(now: string, sourceId: WeatherSourceId, boxItemId: string): KnowHowEntry {
  return {
    schema: "butler.cognition.knowhow.v1",
    knowhow_id: `kh_${randomUUID()}`,
    name: "weather_source_lookup",
    aliases: ["weather", "weather lookup"],
    status: "candidate",
    scope: "global",
    created_at: now,
    updated_at: now,
    summary: "Use a live weather source with timestamp checks before generic search.",
    intent_match: {
      topics: ["weather"],
      examples: ["today weather", "is it raining now"],
    },
    preconditions: [
      "location must be known or inferable",
      "source must provide timestamped current or forecast data",
    ],
    strategy: {
      steps: [
        "resolve location",
        "fetch preferred source",
        "validate source timestamp",
        "answer with current data and source time",
      ],
      preferred_sources: [sourceId],
    },
    freshness: {
      max_age_minutes: 60,
      requires_source_timestamp: true,
      fallback_when_stale: "try_next_source",
    },
    fallback: {
      when_unavailable: "generic_tool_routing",
      when_negative_feedback: "suppress_and_review",
    },
    quality: {
      score: 0.5,
      confidence: 0.5,
      success_count: 1,
      failure_count: 0,
      negative_feedback_count: 0,
      last_used_at: now,
      last_validated_at: now,
    },
    refs: {
      box_item_ids: [boxItemId],
      memory_chunk_ids: [],
      feedback_ids: [],
      consolidation_run_ids: [],
    },
    revision_history: [],
  };
}

function updateWeatherKnowHow(
  entry: KnowHowEntry,
  input: {
    sourceId: WeatherSourceId;
    boxItemId: string;
    score: number;
    now: string;
  },
): KnowHowEntry {
  const successCount = entry.quality.success_count + 1;
  const next: KnowHowEntry = {
    ...entry,
    status: entry.status === "candidate" && successCount >= 2 ? "active" : entry.status,
    updated_at: input.now,
    strategy: {
      ...entry.strategy,
      preferred_sources: [
        input.sourceId,
        ...entry.strategy.preferred_sources.filter((source) => source !== input.sourceId),
      ],
    },
    quality: {
      ...entry.quality,
      score: Number(((entry.quality.score + input.score) / 2).toFixed(3)),
      confidence: Math.min(0.95, Number((entry.quality.confidence + 0.1).toFixed(3))),
      success_count: successCount,
      last_used_at: input.now,
      last_validated_at: input.now,
    },
    refs: {
      ...entry.refs,
      box_item_ids: [...new Set([...entry.refs.box_item_ids, input.boxItemId])],
    },
  };
  return next;
}

export async function runWeatherKnowHow(input: WeatherKnowHowInput): Promise<WeatherKnowHowResult> {
  const nowDate = input.now ?? new Date();
  const now = iso(nowDate);
  const feedback = listFeedbackEntries(input.butlerData);
  const disabledSources = suppressedSources(feedback);
  const knowhow = weatherKnowHow(listKnowHowEntries(input.butlerData));
  const usedKnowHow = Boolean(knowhow && knowhow.status !== "suppressed" && knowhow.status !== "needs_review");
  const attempts = chooseSources(input, usedKnowHow ? knowhow : null, disabledSources);
  if (attempts.length === 0) {
    throw new Error("No weather source available after feedback suppression.");
  }

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      const { snapshot, latencyMs } = await fetchWeatherSource(attempt, input, now);
      const maxAge = knowhow?.freshness.max_age_minutes ?? 60;
      const freshnessAgeMinutes = ageMinutes(snapshot.sourceTimestamp, nowDate);
      const fresh = freshnessAgeMinutes <= maxAge;
      if (!fresh) {
        recordSourceQualityEvent(input.butlerData, {
          source_id: attempt.sourceId,
          source_uri: snapshot.sourceUri,
          tool_name: "weather-knowhow",
          observed_at: now,
          task_kind: "weather",
          freshness_score: 0,
          success: false,
          latency_ms: latencyMs,
          user_feedback: "none",
          box_item_id: null,
          feedback_id: null,
          consolidation_run_id: null,
        });
        continue;
      }
      const boxItemId = createBoxSnapshot(input.butlerData, snapshot, input, now);
      const score = sourceQualityScore(freshnessAgeMinutes, maxAge);
      recordSourceQualityEvent(input.butlerData, {
        source_id: attempt.sourceId,
        source_uri: snapshot.sourceUri,
        tool_name: "weather-knowhow",
        observed_at: now,
        task_kind: "weather",
        freshness_score: score,
        success: true,
        latency_ms: latencyMs,
        user_feedback: "none",
        box_item_id: boxItemId,
        feedback_id: null,
        consolidation_run_id: null,
      });
      const updatedKnowHow = knowhow
        ? updateWeatherKnowHow(knowhow, { sourceId: attempt.sourceId, boxItemId, score, now })
        : createWeatherKnowHow(now, attempt.sourceId, boxItemId);
      writeKnowHowEntry(input.butlerData, updatedKnowHow);
      return {
        location: {
          name: input.locationName ?? `${input.latitude},${input.longitude}`,
          latitude: input.latitude,
          longitude: input.longitude,
        },
        source: attempt.sourceId,
        sourceUri: snapshot.sourceUri,
        sourceTimestamp: snapshot.sourceTimestamp,
        fetchedAt: snapshot.fetchedAt,
        freshnessAgeMinutes,
        fresh,
        summary: snapshot.summary,
        boxItemId,
        knowhowId: updatedKnowHow.knowhow_id,
        usedKnowHow,
        retrievedKnowHowBeforeGenericRouting: true,
        genericRoutingUsed: !usedKnowHow,
        suppressedSources: [...disabledSources],
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("No fresh weather source available.");
}

export function runWeatherConsolidationReview(
  butlerData: string,
  input: { now?: Date } = {},
): { consolidationRunId: string; revisedKnowHowIds: string[]; appliedFeedbackIds: string[] } {
  const now = iso(input.now);
  const consolidationRunId = `cr_${randomUUID()}`;
  const feedback = listFeedbackEntries(butlerData);
  const active = activeFeedback(feedback);
  const knowHows = listKnowHowEntries(butlerData);
  const revisedKnowHowIds: string[] = [];
  const appliedFeedbackIds: string[] = [];

  for (const entry of active) {
    if (!entry.target_ref.startsWith("source:") && !entry.target_ref.startsWith("knowhow:")) continue;
    for (const knowhow of knowHows) {
      if (knowhow.name !== "weather_source_lookup") continue;
      const sourceId = entry.target_ref.replace("source:", "") as WeatherSourceId;
      const targetsKnowHow = entry.target_ref === `knowhow:${knowhow.knowhow_id}`;
      const targetsSource = knowhow.strategy.preferred_sources.includes(sourceId);
      if (!targetsKnowHow && !targetsSource) continue;
      const next: KnowHowEntry = {
        ...knowhow,
        status: entry.category === "source_policy" ? "disabled" : "needs_review",
        updated_at: now,
        strategy: {
          ...knowhow.strategy,
          preferred_sources: knowhow.strategy.preferred_sources.filter((source) => source !== sourceId),
        },
        quality: {
          ...knowhow.quality,
          score: Math.max(0, Number((knowhow.quality.score - 0.25).toFixed(3))),
          negative_feedback_count: knowhow.quality.negative_feedback_count + 1,
        },
        refs: {
          ...knowhow.refs,
          feedback_ids: [...new Set([...knowhow.refs.feedback_ids, entry.feedback_id])],
          consolidation_run_ids: [...new Set([...knowhow.refs.consolidation_run_ids, consolidationRunId])],
        },
        revision_history: [
          ...knowhow.revision_history,
          {
            at: now,
            kind: "negative_feedback_revision",
            feedback_id: entry.feedback_id,
            previous_status: knowhow.status,
          },
        ],
      };
      writeKnowHowEntry(butlerData, next);
      revisedKnowHowIds.push(next.knowhow_id);
    }
    entry.status = "applied";
    entry.updated_at = now;
    appliedFeedbackIds.push(entry.feedback_id);
  }
  if (appliedFeedbackIds.length > 0) writeFeedbackEntries(butlerData, feedback);
  return { consolidationRunId, revisedKnowHowIds, appliedFeedbackIds };
}

export function weatherKnowHowState(butlerData: string): {
  feedbackCount: number;
  activeFeedbackCount: number;
  knowhowCount: number;
  sourceQualityEvents: number;
  boxItems: number;
} {
  const sourcePath = sourceQualityPath(butlerData);
  return {
    feedbackCount: listFeedbackEntries(butlerData).length,
    activeFeedbackCount: activeFeedback(listFeedbackEntries(butlerData)).length,
    knowhowCount: listKnowHowEntries(butlerData).length,
    sourceQualityEvents: existsSync(sourcePath)
      ? readFileSync(sourcePath, "utf8").split(/\r?\n/u).filter(Boolean).length
      : 0,
    boxItems: listBoxManifests(butlerData).length,
  };
}
