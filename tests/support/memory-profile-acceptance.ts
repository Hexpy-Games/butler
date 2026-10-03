import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import type { NativeAppServerHandle } from "./native-app-server.ts";
import { LEGACY_FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";

// Uses the actual controls and native routes; no Memory response fixtures.
export async function checkProfileInstructionSeparation(server: NativeAppServerHandle, browser: Browser) {
  const rules = join(server.butlerData, "cognition/memory/rules");
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, "acceptance.md"), "Keep this instruction after profile deletion.");
  writeFileSync(join(rules, "INDEX.md"), "- [acceptance](acceptance.md)\n");
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en" }) });
  const before = await server.api<{ instructions: unknown[] }>("/memory/instructions");
  if (!before.instructions.length) throw new Error("Profile separation requires seeded instructions");
  await server.api("/personalization", { method: "PATCH", body: JSON.stringify({ profiling: { mode: "basic" } }) });
  const profile = new Database(join(server.butlerData, "cognition/profile/profile.sqlite"));
  profile.run("INSERT OR REPLACE INTO stable_profile_entries(id,category,payload_json,confidence,source_type,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", ["acceptance", "communication", '{"text":"Use concise answers"}', "high", "explicit", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
  profile.close();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  try {
    await server.signIn(page);
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
      key: LEGACY_FIRST_RUN_STORAGE_KEY, value: JSON.stringify(legacyFirstRunCompleteRecord()),
    });
    await page.goto(server.url, { waitUntil: "load" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await page.locator('[data-settings-section-id="profile-memory"]').getByRole("button", { name: "Reset", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Reset", exact: true }).click();
    await page.getByText("Profile reset", { exact: true }).waitFor();
    const applied = await server.api("/memory/instructions");
    if (JSON.stringify(applied) !== JSON.stringify(before)) throw new Error("Profile reset changed instructions");
    console.log("profile instruction separation: Reset preserved instructions");
  } finally { await page.close(); }
}

export async function checkMemoryRefreshDuringRead(server: NativeAppServerHandle, browser: Browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const requested = new Promise<void>((done) => { started = done; });
  let reads = 0;
  try {
    await server.signIn(page);
    await page.addInitScript(({ key, value }) => {
      localStorage.setItem(key, value);
      const Original = window.EventSource;
      const streams: EventSource[] = [];
      (window as unknown as { memorySmokeStreams: EventSource[] }).memorySmokeStreams = streams;
      window.EventSource = class extends Original { constructor(url: string | URL, options?: EventSourceInit) { super(url, options); streams.push(this); } };
    }, { key: LEGACY_FIRST_RUN_STORAGE_KEY, value: JSON.stringify(legacyFirstRunCompleteRecord()) });
    await page.route("**/memory/inventory/check", async (route) => {
      const count = ++reads;
      if (count === 1) { started(); await held; }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { revision: count, kinds: [
        { kind: "automatic", item_count: count, health: { reclaimable_bytes: 0 } },
        { kind: "profile", item_count: 0, health: {} },
      ] } }) });
    });
    await page.goto(server.url, { waitUntil: "load" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Memory", exact: true }).click();
    await requested;
    await page.evaluate(() => {
      for (const stream of (window as unknown as { memorySmokeStreams: EventSource[] }).memorySmokeStreams) {
        stream.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ id: 11000, type: "memory.operation", payload: { kind: "instructions" } }) }));
      }
    });
    release();
    await page.locator('[data-settings-section-id="chat-memory"]').getByText("2", { exact: true }).waitFor();
    if (reads !== 2) throw new Error(`Expected one coalesced change refresh, got ${reads}`);
    console.log("memory change during inventory read: latest state passed");
  } finally { release(); await page.close(); }
}
