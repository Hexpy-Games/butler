import { expect, test } from "bun:test";
import { readEnvelope, type FetchLike } from "../../../butler-protocol/src/client/index.ts";
import { isLocalNetworkHost } from "./localNetwork";
import { pairDevice, pairDeviceName } from "./pair";
import { pairParamsFromUrl, parsePairLink, type PairLink, type PairLinkParams } from "./pairLink";
import { createPairingStore, noiseKeyName, type Pairing } from "./pairings";
import { problemFrom, type Problem } from "./problems";
import { resolveOrigin } from "./resolve";
import { b64urlEncode } from "./tunnel/b64url";

const k = b64urlEncode(new Uint8Array(32).fill(7));
const t = "tun_0123456789ABCDEFGHJKMNPQRS";

// test-category: pure-logic
test("parsePairLink", () => {
  const origin = "http://192.0.2.5:18765";
  const second = "http://192.0.2.6:18765";
  const code = "12345678";
  const prod = "https://api.butler.hexpy.games/v1/tunnel/" + t;
  const dev = "https://butler-cloud-api-dev.hexpy-dev.workers.dev";
  const cases: [PairLinkParams, PairLink | null][] = [
    [{}, null],
    [{ v: "1", a: origin, c: code }, { kind: "pair", origins: [origin], code }],
    [{ v: "1", a: "https://butler.example.com", c: code, x: "later" }, { kind: "pair", origins: ["https://butler.example.com"], code }],
    [{ v: "2", a: origin, c: code }, { kind: "update_app" }],
    [{ v: "2" }, { kind: "update_app" }],
    [{ a: origin, c: code }, { kind: "invalid", origin, code }],
    [{ v: "1", a: origin + "/app", c: "1234" }, { kind: "invalid", origin: null, code: null }],
    [{ v: "1", a: [origin, second], c: code }, { kind: "pair", origins: [origin, second], code }],
    [{ v: "1", a: [origin, origin + "/"], c: code }, { kind: "pair", origins: [origin], code }],
    [{ v: "1", a: [origin, second, origin, second, origin], c: code }, { kind: "invalid", origin, code }],
    [{ v: "1", a: [origin, origin + "/app"], c: code }, { kind: "invalid", origin, code }],
    [{ v: "1", a: [], c: code }, { kind: "invalid", origin: null, code }],
    [{ v: "1", a: origin, c: code, k, t }, { kind: "pair", origins: [origin], code, tunnel: { tunnelId: t, desktopStatic: k, relay: prod } }],
    [{ v: "1", c: code, k, t, u: dev }, { kind: "pair", origins: [], code, tunnel: { tunnelId: t, desktopStatic: k, relay: `${dev}/v1/tunnel/${t}` } }],
    [{ v: "1", a: origin, c: code, k }, { kind: "pair", origins: [origin], code }],
    [{ v: "1", c: code, t }, { kind: "invalid", origin: null, code }],
    [{ v: "1", a: origin, c: code, k: k + "=", t }, { kind: "invalid", origin, code }],
    [{ v: "1", a: origin, c: code, k, t, u: "http://cloud.example.com" }, { kind: "invalid", origin, code }],
  ];
  for (const [params, expected] of cases) expect(parsePairLink(params)).toEqual(expected);
  const scanned = (text: string) => {
    const params = pairParamsFromUrl(text);
    return params ? parsePairLink(params) : null;
  };
  const query = `a=${encodeURIComponent(origin)}&c=${code}`;
  const urls: [string, PairLink | null][] = [
    [`butler://pair?v=1&${query}`, { kind: "pair", origins: [origin], code }],
    [`butler://pair?v=1&a=${encodeURIComponent(second)}&${query}`, { kind: "pair", origins: [second, origin], code }],
    [`https://butler.example.com/pair?v=1&${query}`, null],
    ["hello", null],
    [`butler://pair?v=2&${query}`, { kind: "update_app" }],
  ];
  for (const [text, expected] of urls) expect(scanned(text)).toEqual(expected);
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
    [403, error("pairing_rejected"), "rejected"],
    [410, error("pairing_expired"), "expired"],
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
  let data: unknown = { butler_id: "b-1", device_id: "d1", device_token: "bdt_x.y", computer_name: "Mac mini" };
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status < 300, body: null, json: async () => ({ protocol_version: "butler.app.v1", data, error: { code: "invalid_connection_code" } }) };
  };
  const input = { origin, addresses: [origin], code, matchCode: "47", device: { name: "Test phone", platform: "ios" as const }, fetch };
  expect(await pairDevice(input)).toEqual({ ok: true, pairing: { addresses: [origin], butlerId: "b-1", deviceId: "d1", deviceToken: "bdt_x.y", computerName: "Mac mini" } });
  status = 201;
  data = { butler_id: "b-1", device_id: "d1", device_token: "bdt_x.y", computer_name: "Mac mini" };
  const relayed = await pairDevice({ ...input, noiseStatic: k, tunnel: { tunnelId: t, desktopStatic: k } });
  expect(JSON.parse(String(calls[1].init.body))).toEqual({ code, match_code: "47", device_name: "Test phone", platform: "ios", noise_static: k });
  expect(relayed).toMatchObject({ ok: true, pairing: { tunnelId: t, desktopStatic: k, noiseStatic: "butler.noise.b-1" } });
  expect(calls[0].url).toBe("http://192.0.2.5:18765/devices/pair");
  expect(calls[0].init.method).toBe("POST");
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ code, match_code: "47", device_name: "Test phone", platform: "ios" });
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
  const a = { addresses: ["http://192.0.2.5:18765"], butlerId: "b-1", deviceId: "d1", deviceToken: "bdt_x.y", computerName: "Mac mini" };
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

// test-category: pure-logic
test("resolveOrigin", async () => {
  const envelope = (status: number, body: unknown) => ({ status, ok: status < 300, body: null, json: async () => body });
  const error = (code: string) => ({ protocol_version: "butler.app.v1", error: { code, message: "m" } });
  const stub = (answers: Record<string, () => Promise<ReturnType<typeof envelope>>>): FetchLike =>
    async url => answers[url.replace("/health", "")]();
  const [a, b] = ["http://192.0.2.5:18765", "http://192.0.2.6:18765"];
  const hang = () => new Promise<never>(() => {});
  const ok = async () => envelope(200, { protocol_version: "butler.app.v1", data: { ok: true } });
  expect(await resolveOrigin([a, b], stub({ [a]: hang, [b]: ok }), 200)).toEqual({ ok: true, origin: b });
  expect(await resolveOrigin([a], stub({ [a]: async () => envelope(401, error("local_auth_required")) }))).toEqual({ ok: true, origin: a });
  const refused = async () => envelope(403, error("host_not_allowed"));
  expect(await resolveOrigin([a, b], stub({ [a]: refused, [b]: refused }))).toEqual({ ok: false, problem: "hostNotAllowed" });
  const down = async () => { throw new TypeError("Network request failed"); };
  expect(await resolveOrigin([a, b], stub({ [a]: down, [b]: refused }))).toEqual({ ok: false, problem: "unreachable" });
  const notButler = async () => envelope(404, error("not_butler"));
  expect(await resolveOrigin([a, b], stub({ [a]: notButler, [b]: notButler }))).toEqual({ ok: false, problem: "notButler" });
});

// test-category: pure-logic
test("Pairing records migrate from origin and keep the phone noise key with the pairing", async () => {
  const values = new Map<string, string>();
  const store = createPairingStore({ get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } });
  const lan = "http://192.0.2.5:18765";
  values.set("butler.active", "b-1");
  values.set("butler.pairing.b-1", JSON.stringify({ origin: lan, butlerId: "b-1", deviceId: "d1", deviceToken: "bdt_x.y", pushEnabled: true, pushKinds: ["done", "bogus"] }));
  const migrated: Pairing = { addresses: [lan], butlerId: "b-1", deviceId: "d1", deviceToken: "bdt_x.y", pushEnabled: true, pushKinds: ["done"] };
  expect(await store.loadActive()).toEqual(migrated);
  const relayed = { ...migrated, addresses: [lan, `https://api.butler.hexpy.games/v1/tunnel/${t}`], tunnelId: t, desktopStatic: k, noiseStatic: noiseKeyName("b-1") };
  await store.save(relayed, "cHJpdmF0ZQ");
  expect(await store.loadActive()).toEqual(relayed);
  expect(await store.loadNoiseKey(relayed)).toBe("cHJpdmF0ZQ");
  await store.clear("b-1");
  expect(values.size).toBe(0);
});
