import { expect, test } from "bun:test";
import { readEnvelope, type FetchLike } from "../../../butler-protocol/src/client/index.ts";
import { isLocalNetworkHost } from "./localNetwork";
import { pairDevice, pairDeviceName } from "./pair";
import { parsePairLink, type PairLink, type PairLinkParams } from "./pairLink";
import { createPairingStore } from "./pairings";
import { problemFrom, type Problem } from "./problems";

// test-category: pure-logic
test("parsePairLink", () => {
  const origin = "http://192.0.2.5:18765";
  const code = "12345678";
  const cases: [PairLinkParams, PairLink | null][] = [
    [{}, null],
    [{ v: "1", a: origin, c: code }, { kind: "pair", origin, code }],
    [{ v: "1", a: "https://butler.example.com", c: code, x: "later" }, { kind: "pair", origin: "https://butler.example.com", code }],
    [{ v: "2", a: origin, c: code }, { kind: "update_app" }],
    [{ v: "2" }, { kind: "update_app" }],
    [{ a: origin, c: code }, { kind: "invalid", origin, code }],
    [{ v: "1", a: origin + "/app", c: "1234" }, { kind: "invalid", origin: null, code: null }],
    [{ v: "1", a: [origin], c: code }, { kind: "invalid", origin: null, code }],
  ];
  for (const [params, expected] of cases) expect(parsePairLink(params)).toEqual(expected);
});

// test-category: pure-logic
test("problemFrom", () => {
  const protocol_version = "butler.app.v1";
  const error = (code: string) => ({ protocol_version, error: { code, message: "m" } });
  const caught = (status: number, body: unknown): unknown => {
    try {
      readEnvelope(status, body);
    } catch (error) {
      return error;
    }
  };
  const cases: [number, unknown, Problem][] = [
    [401, error("invalid_connection_code"), "invalidCode"],
    [403, error("host_not_allowed"), "hostNotAllowed"],
    [401, error("local_auth_required"), "needsPairing"],
    [200, { protocol_version: "butler.app.v2" }, "versionMismatch"],
    [404, null, "notButler"],
    [400, error("invalid_request"), "failed"],
    [500, { protocol_version }, "failed"],
    [400, error("toString"), "failed"],
  ];
  for (const [status, body, expected] of cases) expect(problemFrom(caught(status, body))).toBe(expected);
  expect(problemFrom(new TypeError("Network request failed"))).toBe("unreachable");
  expect(problemFrom(new DOMException("x", "AbortError"))).toBe("unreachable");
});

// test-category: pure-logic
test("pairDevice", async () => {
  const origin = "http://192.0.2.5:18765";
  const code = "12345678";
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  let status = 201;
  let data: unknown = { butler_id: "b-1", device_id: "d1", device_token: "bdt_x.y" };
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status < 300, body: null, json: async () => ({ protocol_version: "butler.app.v1", data, error: { code: "invalid_connection_code" } }) };
  };
  const input = { origin, code, device: { name: "Test phone", platform: "ios" as const }, fetch };
  expect(await pairDevice(input)).toEqual({ ok: true, pairing: { origin, butlerId: "b-1", deviceId: "d1", deviceToken: "bdt_x.y" } });
  expect(calls[0].url).toBe("http://192.0.2.5:18765/devices/pair");
  expect(calls[0].init.method).toBe("POST");
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ code, device_name: "Test phone", platform: "ios" });
  expect(calls[0].init.headers.Authorization).toBeUndefined();
  data = { butler_id: "../x", device_id: "d1", device_token: "bdt_x.y" };
  expect(await pairDevice(input)).toEqual({ ok: false, problem: "failed" });
  status = 401;
  expect(await pairDevice(input)).toEqual({ ok: false, problem: "invalidCode" });
  expect(await pairDevice({ ...input, fetch: async () => { throw new TypeError("Network request failed"); } })).toEqual({ ok: false, problem: "unreachable" });
});

// test-category: pure-logic
test("Pairing store", async () => {
  const values = new Map<string, string>();
  const store = createPairingStore({
    get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); },
  });
  const a = { origin: "http://192.0.2.5:18765", butlerId: "b-1", deviceId: "d1", deviceToken: "bdt_x.y" };
  const b = { ...a, butlerId: "b-2" };
  expect(await store.loadActive()).toBeNull();
  await store.save(a);
  await store.save(b);
  expect(await store.loadActive()).toEqual(b);
  expect([...values.keys()].sort()).toEqual(["butler.active", "butler.pairing.b-1", "butler.pairing.b-2"]);
  const updated = { ...a, deviceToken: "bdt_new.token" };
  await store.save(updated);
  expect(await store.loadActive()).toEqual(updated);
  await store.clear("b-2");
  expect(await store.loadActive()).toEqual(updated);
  await store.clear("b-1");
  expect(await store.loadActive()).toBeNull();
  expect(values.size).toBe(0);
  values.set("butler.active", "b-9");
  values.set("butler.pairing.b-9", "{}");
  expect(await store.loadActive()).toBeNull();
});

// test-category: pure-logic
test("pairDeviceName and isLocalNetworkHost", () => {
  expect(pairDeviceName([" Phone "], "iOS")).toBe("Phone");
  expect(pairDeviceName([null, " ", "Next"], "iOS")).toBe("Next");
  expect(pairDeviceName([], "iOS")).toBe("iOS");
  expect(pairDeviceName(["Ph\u0007one"], "iOS")).toBe("Phone");
  expect(pairDeviceName(["a".repeat(70)], "iOS")).toBe("a".repeat(64));
  expect(Array.from(pairDeviceName(["📱".repeat(70)], "iOS")).length).toBe(64);
  const cases: [string, boolean][] = [
    ["192.168.0.20", true], // privacy-hygiene: allow-private-ip
    ["10.0.0.5", true], // privacy-hygiene: allow-private-ip
    ["172.20.1.1", true], // privacy-hygiene: allow-private-ip
    ["169.254.3.4", true], // privacy-hygiene: allow-private-ip
    ["[fe80::1]", true], // privacy-hygiene: allow-private-ip
    ["[fd12::1]", true], // privacy-hygiene: allow-private-ip
    ["macmini.local", true],
    ["macmini", true],
    ["172.32.0.1", false],
    ["localhost", false],
    ["127.0.0.1", false],
    ["butler.example.com", false],
    ["192.0.2.5", false],
    ["[2001:db8::1]", false],
  ];
  for (const [host, expected] of cases) expect(isLocalNetworkHost(`http://${host}`)).toBe(expected);
});
