import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useProjectStatistics } from "./useProjectStatistics.ts";
import { FakeClock } from "./live-session/liveSessionTestClock.ts";

let root: Root;
const clock = new FakeClock();
const original = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator };
let latest: ReturnType<typeof useProjectStatistics>;
let requests: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>;
function Harness({ period = 7, revision = "1" }: { period?: 7 | 30 | 90; revision?: string }) {
  latest = useProjectStatistics("project", period, "UTC", revision);
  return null;
}
async function setup() {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  requests = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.butlerApp = { getProjectDashboardResource: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) };
  clock.install();
  root = createRoot(dom.window.document.querySelector("#root")!);
  await act(async () => root.render(<Harness />));
}
const data = (period = 7) => ({ period, activity: { buckets: [] }, materialTypes: { buckets: [] }, execution: { outcomes: {} }, sources: {}, sessionHistoryAvailable: true });
afterEach(async () => {
  await act(async () => root?.unmount());
  clock.uninstall();
  Object.assign(globalThis, original);
});

test("live revisions do not starve an in-flight period and coalesce one refresh", async () => {
  await setup();
  await act(async () => root.render(<Harness revision="2" />));
  await act(async () => root.render(<Harness revision="3" />));
  expect(requests).toHaveLength(1);
  await act(async () => requests[0]!.resolve(data()));
  expect(latest.data?.period).toBe(7);
  expect(latest.loading).toBe(true);
  expect(requests).toHaveLength(2);
  await act(async () => requests[1]!.resolve(data()));
  expect(latest.loading).toBe(false);
});

test("stalled bridge exits loading, ignores late reply and retries only on request", async () => {
  await setup();
  await act(async () => clock.advanceBy(20_000));
  expect(latest.loading).toBe(false);
  expect(latest.error).toBe(true);
  await act(async () => root.render(<Harness revision="2" />));
  expect(requests).toHaveLength(1);
  await act(async () => latest.retry());
  expect(requests).toHaveLength(2);
  await act(async () => requests[0]!.resolve(data(90)));
  expect(latest.data).toBeUndefined();
  await act(async () => requests[1]!.resolve(data()));
  expect(latest.error).toBe(false);
  expect(latest.data?.period).toBe(7);
});

test("period switch fences old responses; failed refresh preserves current-period data", async () => {
  await setup();
  await act(async () => root.render(<Harness period={90} />));
  await act(async () => requests[0]!.resolve(data()));
  expect(latest.data).toBeUndefined();
  await act(async () => requests[1]!.resolve(data(90)));
  await act(async () => root.render(<Harness period={90} revision="2" />));
  expect(latest.data?.period).toBe(90);
  await act(async () => requests[2]!.reject(new Error("offline")));
  expect(latest.data?.period).toBe(90);
  expect(latest.error).toBe(true);
  expect(latest.loading).toBe(false);
});
