import { expect, test } from "bun:test";
import { butlerOrigin } from "./probe";
import { displayAddress } from "./route";

// test-category: pure-logic
test("a typed address becomes a plain http(s) origin", () => {
  const cases: [string, string | null][] = [
    ["192.0.2.5:18765", "http://192.0.2.5:18765"],
    ["  https://butler.example.com/ ", "https://butler.example.com"],
    ["butler.local", "http://butler.local"],
    ["", null],
    ["ftp://butler.example.com", null],
    ["http://butler.example.com/app", null],
    ["http://h?x=1", null],
  ];
  for (const [input, expected] of cases) expect(butlerOrigin(input)).toBe(expected);
});

// test-category: pure-logic
test("displayAddress labels the relay and preserves the LAN address", () => {
  const lan = "http://192.0.2.5:18765";
  const tunnelId = "tun_0123456789ABCDEFGHJKMNPQRS";
  const relay = `https://relay.example.com/v1/tunnel/${tunnelId}`;
  const pairing = { addresses: [lan, relay], tunnelId, butlerId: "b-1", deviceId: "d1", deviceToken: "bdt_x.y" };
  const label = "Outside access";
  expect(displayAddress(pairing, relay, label)).toBe(label);
  expect(displayAddress(pairing, lan, label)).toBe(lan);
});
