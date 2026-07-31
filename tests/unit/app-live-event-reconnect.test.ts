import { expect, test } from "bun:test";
import {
  liveEventReconnectDelayMs,
} from "../../packages/butler-app/client/ui/src/hooks/live-session/liveEventReconnect.ts";

test("reconnect delays back off and stay capped", () => {
  expect([
    liveEventReconnectDelayMs(0),
    liveEventReconnectDelayMs(1),
    liveEventReconnectDelayMs(2),
    liveEventReconnectDelayMs(5),
    liveEventReconnectDelayMs(100),
  ]).toEqual([1_000, 2_000, 4_000, 30_000, 30_000]);
});
