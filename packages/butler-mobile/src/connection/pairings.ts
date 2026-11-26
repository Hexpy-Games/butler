export const PUSH_KINDS = ["needs_input", "done", "failed", "schedule_blocked"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export type Pairing = {
  addresses: string[]; // LAN first; when tunnelId is set, the last entry is the relay address "<base>/v1/tunnel/<id>"
  butlerId: string; deviceId: string; deviceToken: string; computerName?: string;
  pushEnabled?: boolean; pushKinds?: PushKind[];
  tunnelId?: string; desktopStatic?: string; noiseStatic?: string; // all three or none; noiseStatic = SecureStore key of the phone private key
};

export const noiseKeyName = (butlerId: string) => "butler.noise." + butlerId;

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function isStorableId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id);
}

export function stringField(value: object, key: string): string | null {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" && field !== "" ? field : null;
}

function readPairing(raw: string | null): Pairing | null {
  try {
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const rawAddresses: unknown = Reflect.get(value, "addresses");
    const origin = stringField(value, "origin");
    const addresses = Array.isArray(rawAddresses) && rawAddresses.length > 0 && rawAddresses.every((entry): entry is string => typeof entry === "string" && entry !== "")
      ? rawAddresses : origin ? [origin] : null;
    const tunnelId = stringField(value, "tunnelId");
    const desktopStatic = stringField(value, "desktopStatic");
    const noiseStatic = stringField(value, "noiseStatic");
    const butlerId = stringField(value, "butlerId");
    const deviceId = stringField(value, "deviceId");
    const deviceToken = stringField(value, "deviceToken");
    const computerName = stringField(value, "computerName");
    const pushEnabled: unknown = Reflect.get(value, "pushEnabled");
    const pushKinds: unknown = Reflect.get(value, "pushKinds");
    return addresses && butlerId && deviceId && deviceToken ? {
      addresses, butlerId, deviceId, deviceToken,
      ...(computerName ? { computerName } : {}),
      ...(typeof pushEnabled === "boolean" ? { pushEnabled } : {}),
      ...(Array.isArray(pushKinds) ? { pushKinds: PUSH_KINDS.filter(k => pushKinds.includes(k)) } : {}),
      ...(tunnelId && desktopStatic && noiseStatic ? { tunnelId, desktopStatic, noiseStatic } : {}),
    } : null;
  } catch {
    return null;
  }
}

const ACTIVE = "butler.active";
const pairingKey = (id: string) => "butler.pairing." + id;

export function createPairingStore(kv: KeyValueStore) {
  return {
    /** `noisePrivate` (base64url) is written under noiseKeyName(butlerId) when the pairing has a relay; a pairing without one removes that key. */
    async save(p: Pairing, noisePrivate?: string): Promise<void> {
      if (!p.noiseStatic) await kv.remove(noiseKeyName(p.butlerId));
      else if (noisePrivate) await kv.set(p.noiseStatic, JSON.stringify({ v: 1, private: noisePrivate }));
      await kv.set(pairingKey(p.butlerId), JSON.stringify(p));
      await kv.set(ACTIVE, p.butlerId);
    },
    async loadNoiseKey(p: Pairing): Promise<string | null> {
      if (!p.noiseStatic || !isStorableId(p.noiseStatic)) return null;
      try {
        const value: unknown = JSON.parse((await kv.get(p.noiseStatic)) ?? "null");
        return value && typeof value === "object" && Reflect.get(value, "v") === 1 ? stringField(value, "private") : null;
      } catch {
        return null;
      }
    },
    async loadActive(): Promise<Pairing | null> {
      const id = await kv.get(ACTIVE);
      if (!id || !isStorableId(id)) return null;
      const pairing = readPairing(await kv.get(pairingKey(id)));
      return pairing?.butlerId === id ? pairing : null;
    },
    async setPush(butlerId: string, patch: Pick<Pairing, "pushEnabled" | "pushKinds">): Promise<void> {
      const key = pairingKey(butlerId);
      const pairing = readPairing(await kv.get(key));
      if (pairing) await kv.set(key, JSON.stringify({ ...pairing, ...patch }));
    },
    async clear(butlerId: string): Promise<void> {
      await kv.remove(noiseKeyName(butlerId));
      await kv.remove(pairingKey(butlerId));
      if (await kv.get(ACTIVE) === butlerId) await kv.remove(ACTIVE);
    },
  };
}

export type PairingStore = ReturnType<typeof createPairingStore>;
