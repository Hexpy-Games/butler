import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { boxItemRoot, readBoxManifest } from "../../packages/butler-agent/src/agent/cognition/box/store.ts";
import { listSourceQualityEvents, readKnowHowEntry } from "../../packages/butler-agent/src/agent/cognition/know-how/store.ts";
import { runWeatherKnowHow } from "../../packages/butler-agent/src/agent/cognition/weather-knowhow.ts";

function tempData(): string {
  return mkdtempSync(join(tmpdir(), "butler-weather-knowhow-"));
}

test("weather know-how writes through generic Box and know-how stores", async () => {
  const butlerData = tempData();
  try {
    const fetcher = (async () => new Response(JSON.stringify({
      current: {
        time: "2026-05-15T00:00",
        temperature_2m: 22,
        apparent_temperature: 23,
        precipitation: 0,
        wind_speed_10m: 3,
      },
    }), { status: 200 })) as unknown as typeof fetch;
    const result = await runWeatherKnowHow({
      butlerData,
      latitude: 37.5665,
      longitude: 126.9780,
      locationName: "Seoul",
      now: new Date("2026-05-15T00:10:00.000Z"),
      fetcher,
    });

    const manifest = readBoxManifest(butlerData, result.boxItemId);
    expect(manifest?.schema).toBe("butler.cognition.box.item.v1");
    expect(manifest?.files[0]?.sha256).toBeTruthy();
    expect(manifest?.files[0]?.size_bytes).toBeGreaterThan(0);
    expect(readFileSync(join(boxItemRoot(butlerData, result.boxItemId), "content", "snapshot.json"), "utf8")).toContain("temperature_2m");

    const knowhow = readKnowHowEntry(butlerData, result.knowhowId);
    expect(knowhow?.refs.box_item_ids).toContain(result.boxItemId);
    expect(knowhow?.strategy.preferred_sources).toContain("open-meteo");

    const [event] = listSourceQualityEvents(butlerData);
    expect(event).toMatchObject({
      schema: "butler.cognition.source-quality-event.v1",
      source_id: "open-meteo",
      tool_name: "weather-knowhow",
      success: true,
      box_item_id: result.boxItemId,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
